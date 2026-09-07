/**
 * docs/294 — what a send does with the composer's attachments.
 *
 * This logic used to live inline in `App.handleSend`, answered separately by
 * each branch, and `App.tsx` has no test harness. Three silent losses came out
 * of that: `/review` dispatched without the uploads, then without the
 * `@`-mentioned files, and `/compact` discarded both.
 */
import { describe, it, expect } from "vitest";
import { buildAttachmentPlan } from "./attachment-plan.js";
import type { UploadItem, UploadRef } from "../../server/shared/types.js";

const NOTES: UploadRef = { path: "/uploads/notes.txt", type: "upload" };
const SHOT: UploadRef = { path: "/uploads/shot.png", type: "upload" };

function upload(patch: Partial<UploadItem>): UploadItem {
  return {
    id: "u1",
    name: "notes.txt",
    status: "ready",
    progress: 100,
    path: "/uploads/notes.txt",
    pending: true,
    ...patch,
  } as UploadItem;
}

describe("buildAttachmentPlan — an ordinary message", () => {
  it("carries both kinds and clears them", () => {
    const plan = buildAttachmentPlan({
      text: "look at this",
      uploadRefs: [NOTES],
      uploads: [upload({})],
      pendingFiles: [{ path: "src/index.ts" }],
    });
    expect(plan.frame).toEqual({
      uploads: [NOTES],
      files: [{ path: "src/index.ts" }],
    });
    expect(plan.bubble.uploadPaths).toEqual(["/uploads/notes.txt"]);
    expect(plan.bubble.files).toEqual([
      { path: "src/index.ts", contentPreview: "" },
      { path: "/uploads/notes.txt", contentPreview: "" },
    ]);
    expect(plan.clearAttachments).toBe(true);
  });

  it("omits each key when that kind is absent", () => {
    // The server reads both as absent-or-non-empty; an empty array would send it
    // down the attachment-resolution path for nothing.
    const plan = buildAttachmentPlan({
      text: "hello", uploadRefs: [], uploads: [], pendingFiles: [],
    });
    // `toEqual({})` passes for a key set to `undefined`; the key must be absent,
    // so the frame does not send the server down the attachment path for nothing.
    expect(Object.keys(plan.frame)).toEqual([]);
    expect(Object.keys(plan.bubble)).toEqual([]);
    expect(plan.clearAttachments).toBe(true);
  });

  it("shows an image upload as a thumbnail, not a file row", () => {
    const plan = buildAttachmentPlan({
      text: "what is this",
      uploadRefs: [SHOT],
      uploads: [upload({
        id: "img", name: "shot.png", path: "/uploads/shot.png",
        previewUrl: "blob:shot", mimeType: "image/png",
      })],
      pendingFiles: [],
    });
    expect(plan.bubble.images).toEqual([
      { data: "", mediaType: "image/png", src: "blob:shot" },
    ]);
    // ...and not ALSO as a file row, which would draw it twice.
    expect(plan.bubble.files).toBeUndefined();
    // The frame still references it — the thumbnail is display only.
    expect(plan.frame.uploads).toEqual([SHOT]);
  });

  it("prefers the stable data URL over the blob URL for an image", () => {
    // A blob URL is revoked when the chip churns; the bubble outlives it.
    const plan = buildAttachmentPlan({
      text: "x",
      uploadRefs: [SHOT],
      uploads: [upload({
        id: "img", name: "shot.png", path: "/uploads/shot.png",
        previewUrl: "blob:shot", dataUrl: "data:image/png;base64,AAA",
        mimeType: "image/png",
      })],
      pendingFiles: [],
    });
    expect(plan.bubble.images?.[0].src).toBe("data:image/png;base64,AAA");
  });

  it("ignores an upload that is not ready, even though it has a path", () => {
    // Split from the missing-path case below on purpose: combined, either
    // condition alone rejected the fixture, so neither was actually pinned.
    const plan = buildAttachmentPlan({
      text: "x",
      uploadRefs: [SHOT],
      uploads: [upload({
        id: "img", name: "shot.png", path: "/uploads/shot.png",
        status: "error", previewUrl: "blob:x", mimeType: "image/png",
      })],
      pendingFiles: [],
    });
    expect(plan.bubble.images).toBeUndefined();
    expect(plan.bubble.files).toEqual([{ path: "/uploads/shot.png", contentPreview: "" }]);
  });

  it("ignores a ready upload that has no path yet", () => {
    const plan = buildAttachmentPlan({
      text: "x",
      uploadRefs: [SHOT],
      uploads: [upload({
        id: "img", name: "shot.png", path: undefined,
        status: "ready", previewUrl: "blob:x", mimeType: "image/png",
      })],
      pendingFiles: [],
    });
    expect(plan.bubble.images).toBeUndefined();
    expect(plan.bubble.files).toEqual([{ path: "/uploads/shot.png", contentPreview: "" }]);
  });
});

describe("buildAttachmentPlan — /compact (docs/294 reqs 5-6)", () => {
  it("carries nothing and takes nothing away", () => {
    const plan = buildAttachmentPlan({
      text: "/compact",
      uploadRefs: [NOTES],
      uploads: [upload({})],
      pendingFiles: [{ path: "src/index.ts" }],
    });
    expect(Object.keys(plan.frame)).toEqual([]);
    expect(Object.keys(plan.bubble)).toEqual([]);
    // req 5 — the attachments stay in the composer for the next real message.
    expect(plan.clearAttachments).toBe(false);
  });

  it("treats the instruction form as the same command", () => {
    const plan = buildAttachmentPlan({
      text: "/compact keep the design decisions",
      uploadRefs: [NOTES],
      uploads: [upload({})],
      pendingFiles: [],
    });
    expect(plan.frame).toEqual({});
    expect(plan.clearAttachments).toBe(false);
  });

  it("does not mistake a longer word for the command", () => {
    // Non-vacuous control for the three cases above.
    const plan = buildAttachmentPlan({
      text: "/compactfoo",
      uploadRefs: [NOTES],
      uploads: [upload({})],
      pendingFiles: [],
    });
    expect(plan.frame.uploads).toEqual([NOTES]);
    expect(plan.clearAttachments).toBe(true);
  });
});
