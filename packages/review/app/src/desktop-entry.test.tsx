// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { mountReviewCanvas } from "./desktop-entry";

let canvas: ReturnType<typeof mountReviewCanvas> | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("offers deliberate recovery actions while the selected Review Server profile is disconnected", async () => {
  const retry = vi.fn<() => void>();
  const editCredentials = vi.fn<() => void>();
  const switchProfile = vi.fn<() => void>();
  const container = document.createElement("div");
  document.body.append(container);

  await act(async () => {
    canvas = mountReviewCanvas(container, {
      kind: "error",
      message: "The Review Server “Development” is unreachable.",
      connection: {
        profileName: "Development",
        reason: "unreachable",
        retry,
        editCredentials,
        switchProfile,
      },
    });
  });

  expect(container.textContent).toContain("Review Server disconnected");
  expect(container.textContent).toContain("Development");
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual([
    "Retry",
    "Edit credentials",
    "Switch profile",
  ]);
  await act(async () => {
    for (const button of buttons) button.click();
  });
  expect(retry).toHaveBeenCalledOnce();
  expect(editCredentials).toHaveBeenCalledOnce();
  expect(switchProfile).toHaveBeenCalledOnce();
});
