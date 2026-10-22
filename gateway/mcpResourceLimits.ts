// Bound SDK validation work before individual tool schemas run. The 256 KiB
// management payload budget can contain more than 10,000 short dependency IDs;
// retain room for those existing batches rather than silently narrowing them.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 100_000

// Keep the SDK's 4 MiB HTTP body budget explicit for both public and authenticated
// transports. This applies to streamed bodies too, not only Content-Length.
export const MCP_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024
