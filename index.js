// OpenCode provider `claude-code` -- the entry point OpenCode loads (`aisdk:file:///<repo>/index.js`).
// The provider lives in src/ (provider.js and its modules). OpenCode takes the FIRST export whose name
// starts with "create", so this file exports only the factory.
export { createClaudeCode } from "./src/provider.js"
