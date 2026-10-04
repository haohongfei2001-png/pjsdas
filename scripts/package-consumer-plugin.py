#!/usr/bin/env python3
"""Build a deterministic candidate from reviewed files. Never upload or activate it."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "plugins/todayaction"
FILES = ("plugin.json", "mcp.json", "assets/icon.png", "assets/logo.png")


def validate(package=PACKAGE, source=ROOT):
    actual = set()
    for path in package.rglob("*"):
        if path.is_symlink():
            raise ValueError("Package symlinks are not permitted")
        if path.is_file():
            actual.add(path.relative_to(package).as_posix())
    if actual != set(FILES):
        raise ValueError("Package must contain only the reviewed manifest, MCP declaration and two icons")
    manifest = json.loads((package / "plugin.json").read_text())
    mcp = json.loads((package / "mcp.json").read_text())
    if set(manifest) - {"$schema", "name", "version", "description", "homepage", "repository", "keywords", "extensions", "author"}:
        raise ValueError("Unreviewed root manifest fields are not allowed")
    if manifest.get("$schema") != "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json":
        raise ValueError("Use the portable Agent Plugins manifest schema")
    if mcp != {
        "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        "mcpServers": {"todayaction": {"type": "streamable-http", "url": "https://todayaction.com/api/mcp"}},
    }:
        raise ValueError("Use only the reviewed universal MCP endpoint, without headers, credentials or local commands")
    if manifest.get("name") != "todayaction" or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?", manifest.get("version", "")):
        raise ValueError("Invalid package identity/version")
    extension = manifest["extensions"]["com.openai"]
    if set(extension) - {"interface", "review", "publication"}:
        raise ValueError("Registered app mappings, hooks and unreviewed extensions are not allowed")
    # No credentials or reviewer instructions belong in any package metadata.
    def inspect(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if re.search(r"secret|password|token|credentials|reviewer_instructions", key, re.I):
                    raise ValueError("Credential/reviewer access fields must stay outside the package")
                inspect(item)
        elif isinstance(value, list):
            for item in value:
                inspect(item)
    inspect(manifest)
    interface = extension["interface"]
    for field, limit in (("displayName", 30), ("shortDescription", 30), ("longDescription", 4000)):
        value = interface.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError(f"{field} must contain 1-{limit} characters")
    prompts = interface.get("defaultPrompt", [])
    if not isinstance(prompts, list) or len(prompts) > 3:
        raise ValueError("Use at most three default prompts")
    normalized = []
    for prompt in prompts:
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 128 or "\n" in prompt or "\r" in prompt:
            raise ValueError("Default prompts must be nonblank single lines of at most 128 characters")
        normalized.append(" ".join(prompt.split()))
    if len(set(normalized)) != len(normalized):
        raise ValueError("Default prompts must be unique after whitespace normalization")
    for field, filename in (("composerIcon", "assets/icon.png"), ("logo", "assets/logo.png")):
        if interface.get(field) != "./" + filename or not (package / filename).read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Package icons must be the reviewed local PNG assets")
    registered = set(re.findall(r"registerTool\('([^']+)'", (source / "gateway/serverFactory.ts").read_text()))
    cases = extension["review"]["test_cases"]
    if len(cases.get("positive", [])) != 5 or len(cases.get("negative", [])) != 3:
        raise ValueError("Keep exactly five positive and three negative review cases")
    for kind in ("positive", "negative"):
        for case in cases[kind]:
            required = ("description", "prompt", "tools_triggered", "expected_behavior") if kind == "positive" else ("description", "prompt")
            if not all(isinstance(case.get(k), str) and case[k].strip() for k in required):
                raise ValueError("Each case needs observable expected behavior")
            if kind == "negative" and any(k in case for k in ("tools_triggered", "expected_behavior")):
                raise ValueError("Negative cases state prohibited tool use and expectations in their description")
            if kind == "positive":
                names = {s.strip() for s in case.get("tools_triggered", "").split(",")}
                if not names or not names <= registered:
                    raise ValueError("Review cases reference an unknown source tool")
    # These omissions are deliberate until the operator supplies verified values.
    missing = [field for field in ("developerName", "supportURL", "privacyPolicyURL", "termsOfServiceURL") if not interface.get(field)]
    if not extension["review"].get("demo_recording_url"):
        missing.append("demo_recording_url")
    for field in ("websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"):
        value = interface.get(field)
        if value and not re.fullmatch(r"https://[^\s@?#]+(?:[/?#][^\s]*)?", value):
            raise ValueError("Public metadata links must be HTTPS URLs without embedded credentials")
    return manifest, missing


def build(destination, package=PACKAGE, source=ROOT):
    manifest, missing = validate(package, source)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for filename in sorted(FILES):
            info = zipfile.ZipInfo(filename, (2026, 10, 3, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, (package / filename).read_bytes())
    return {
        "name": manifest["name"], "version": manifest["version"],
        "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "files": list(sorted(FILES)), "sourceValidation": "PASS",
        "missingSubmissionMetadata": missing,
        "dashboardValidation": "NOT_RUN", "installedHostAcceptance": "NOT_RUN",
        "publicAvailability": "NOT_ENABLED",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write candidate ZIP to this path")
    parser.add_argument("--require-submission-metadata", action="store_true", help="Fail if required identity, policy or demo metadata is absent; this does not certify publication")
    args = parser.parse_args()
    try:
        _, missing = validate()
        if args.require_submission_metadata and missing:
            raise ValueError("Submission metadata incomplete: " + ", ".join(missing))
        report = build(args.output) if args.output else {"sourceValidation": "PASS", "missingSubmissionMetadata": missing, "installedHostAcceptance": "NOT_RUN"}
        print(json.dumps(report, indent=2))
    except (ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
