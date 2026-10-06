// node --test test/images.test.js
// An image the window sends reaches Claude Code: whatever shape the file part comes in, fileParts gives the package
// (ai-sdk-provider-claude-code, provider spec v4) the tagged `data` it reads. Checked against the package's own
// converter, so a change of the package's expectations shows here (2026-10-06: the model got only "[Image 1]").
import assert from "node:assert/strict"
import { copyFileSync, appendFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"
import { fileParts, filesInfo, rawUserTurn } from "../src/lib.js"

// the package's converter is internal: a copy of its module next to it, with the converter exported
const dist = path.dirname(createRequire(import.meta.url).resolve("ai-sdk-provider-claude-code"))
const probe = path.join(dist, `.probe-${process.pid}.js`)
copyFileSync(path.join(dist, "index.js"), probe)
appendFileSync(probe, "\nexport { convertToClaudeCodeMessages as __convert }\n")
const { __convert } = await import(pathToFileURL(probe).href)
after(() => rmSync(probe, { force: true }))

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const bytes = Uint8Array.from(Buffer.from(PNG, "base64"))
const turn = (part) => [{ role: "user", content: [{ type: "text", text: "[Image 1] что на картинке?" }, part] }]
const images = (c) => c.streamingContentParts.filter((p) => p.type === "image")

const shapes = {
  "a bare base64 string": { type: "file", mediaType: "image/png", data: PNG },
  bytes: { type: "file", mediaType: "image/png", data: bytes },
  "a data: URL string": { type: "file", mediaType: "image/png", data: `data:image/png;base64,${PNG}` },
  "a data: URL object": { type: "file", mediaType: "image/png", data: new URL(`data:image/png;base64,${PNG}`) },
  "an old image part": { type: "image", mimeType: "image/png", image: PNG },
}
for (const [name, part] of Object.entries(shapes))
  test(`an image as ${name} reaches the package as an image block`, () => {
    const prompt = rawUserTurn(fileParts(turn(part)))
    assert.equal(prompt[0].role, "user", "a turn with an image stays a user message")
    const c = __convert(prompt)
    assert.equal(c.hasImageParts, true, JSON.stringify(c.warnings))
    assert.equal(images(c).length, 1)
    assert.equal(images(c)[0].source.type, "base64")
    assert.equal(images(c)[0].source.media_type, "image/png")
    assert.equal(images(c)[0].source.data, PNG)
  })

test("without fileParts the old shapes are dropped by the package (what the window saw)", () => {
  for (const part of [shapes["a bare base64 string"], shapes.bytes, shapes["an old image part"]]) assert.equal(__convert(turn(part)).hasImageParts, false)
})

test("a part already in the package's shape passes unchanged", () => {
  const part = { type: "file", mediaType: "image/png", data: { type: "data", data: PNG } }
  assert.deepEqual(fileParts(turn(part))[0].content[1], part)
})

test("filesInfo names what arrived", () => {
  assert.deepEqual(filesInfo(turn(shapes["a bare base64 string"])), ["image/png string 0K"])
  assert.deepEqual(filesInfo(fileParts(turn(shapes.bytes))), ["image/png data 0K"])
})
