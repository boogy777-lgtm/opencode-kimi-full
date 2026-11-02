import { test, expect } from "bun:test"
import { buildModel } from "../src/v2.ts"

// The V2 model object is the only place the display key and the wire slug are
// allowed to diverge. Keeping them separate is what makes the picker label
// (`Kimi K3`) usable in agent files while the adapter still sends `k3`.
test("V2 model keeps the display key and the server wire slug separate", () => {
  const model = buildModel(
    {
      id: "k3",
      display_name: "Kimi K3",
      context_length: 1_048_576,
      supports_image_in: true,
      supports_video_in: false,
      supports_reasoning: true,
      think_efforts: { valid_efforts: ["low", "high", "max"] },
    },
    "Kimi K3",
  )

  expect(model.id as string).toBe("Kimi K3")
  expect(model.modelID as string).toBe("k3")
  expect(model.name).toBe("Kimi K3")
  expect(model.capabilities.input).toEqual(["text", "image"])
  expect(model.capabilities.temperature).toBe(false)
  expect(model.limit).toEqual({ context: 1_048_576, output: 65_536 })
  // The server's tier list is authoritative: no fabricated `medium`.
  expect(model.variants.map((variant) => variant.id as string)).toEqual([
    "off",
    "auto",
    "low",
    "high",
    "max",
  ])
  expect(model.variants.find((variant) => (variant.id as string) === "high")?.body).toEqual({
    reasoning_effort: "high",
  })
})

test("V2 model for a non-reasoning model carries no variants", () => {
  const model = buildModel(
    { id: "kimi-for-coding", display_name: "Kimi Code", supports_reasoning: false },
    "Kimi Code",
  )
  expect(model.variants).toEqual([])
  expect(model.capabilities.input).toEqual(["text", "image"])
})
