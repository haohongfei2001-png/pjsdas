import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("package_plugin", ROOT / "scripts/package-consumer-plugin.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / "package"
        shutil.copytree(module.PACKAGE, self.package)

    def edit(self, file, mutate):
        path = self.package / file
        data = json.loads(path.read_text())
        mutate(data)
        path.write_text(json.dumps(data))

    def test_deterministic_zip_has_only_reviewed_files_and_no_false_acceptance(self):
        a, b = self.root / "a.zip", self.root / "b.zip"
        receipt = module.build(a, self.package)
        module.build(b, self.package)
        self.assertEqual(a.read_bytes(), b.read_bytes())
        with zipfile.ZipFile(a) as archive:
            self.assertEqual(archive.namelist(), sorted(module.FILES))
        self.assertEqual(receipt["installedHostAcceptance"], "NOT_RUN")
        self.assertEqual(receipt["publicAvailability"], "NOT_ENABLED")
        self.assertIn("developerName", receipt["missingSubmissionMetadata"])

    def test_extra_secret_file_rejected(self):
        (self.package / ".env").write_text("SYNTHETIC_ONLY=not-a-secret")
        with self.assertRaises(ValueError): module.validate(self.package)

    def test_symlink_rejected_even_when_it_replaces_an_allowed_path(self):
        icon = self.package / "assets/icon.png"
        icon.unlink()
        icon.symlink_to(module.PACKAGE / "assets/icon.png")
        with self.assertRaises(ValueError): module.validate(self.package)

    def test_auth_header_rejected(self):
        self.edit("mcp.json", lambda d: d["mcpServers"]["todayaction"].update(headers={"Authorization": "synthetic"}))
        with self.assertRaises(ValueError): module.validate(self.package)

    def test_endpoint_substitution_rejected(self):
        self.edit("mcp.json", lambda d: d["mcpServers"]["todayaction"].update(url="https://example.invalid/mcp"))
        with self.assertRaises(ValueError): module.validate(self.package)

    def test_unverified_registered_app_mapping_rejected(self):
        self.edit("plugin.json", lambda d: d["extensions"]["com.openai"].update(apps="./.app.json"))
        with self.assertRaises(ValueError): module.validate(self.package)

    def test_unknown_review_tool_rejected(self):
        self.edit("plugin.json", lambda d: d["extensions"]["com.openai"]["review"]["test_cases"]["positive"][0].update(tools_triggered="grant_me_access"))
        with self.assertRaises(ValueError): module.validate(self.package)

    def test_reviewer_credentials_rejected(self):
        self.edit("plugin.json", lambda d: d["extensions"]["com.openai"]["review"].update(test_credentials="synthetic"))
        with self.assertRaises(ValueError): module.validate(self.package)


if __name__ == "__main__":
    unittest.main()
