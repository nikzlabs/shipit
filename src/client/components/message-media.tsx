import { FileIcon as PhFileIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { ChatMessageImage, ChatMessageFile } from "./MessageList.js";

/** Render file attachment chips on a message bubble. Clicking opens the preview modal. */
export function MessageFileAttachments({ files }: { files: ChatMessageFile[] }) {
  const handleClick = (filePath: string) => {
    const sid = useSessionStore.getState().sessionId;
    if (sid) void useFileStore.getState().openPreview(sid, filePath);
  };

  return (
    <div className="flex gap-1.5 flex-wrap mt-2" data-testid="message-files">
      {files.map((f, i) => {
        const fileName = f.path.split("/").pop() ?? f.path;
        const lineRange = f.startLine && f.endLine ? ` L${f.startLine}-${f.endLine}` : "";
        return (
          <button
            key={`${f.path}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-white/10 border border-white/20 rounded text-xs hover:bg-white/20 transition-colors cursor-pointer"
            title={f.path}
            onClick={() => handleClick(f.path)}
          >
            <PhFileIcon size={ICON_SIZE.XS} className="shrink-0 opacity-60" />
            <span className="truncate max-w-[150px]">{fileName}</span>
            {lineRange && <span className="opacity-60">{lineRange}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Render inline image thumbnails for a user message. Clicking opens the preview modal. */
export function MessageImages({ images, isUserMessage }: { images: ChatMessageImage[]; isUserMessage: boolean }) {
  return (
    <div className={`flex gap-2 flex-wrap ${images.length > 0 && isUserMessage ? "mt-2" : "mb-2"}`} data-testid="message-images">
      {images.map((img, i) => {
        const src = `data:${img.mediaType};base64,${img.data}`;
        const alt = `Attached image ${i + 1}`;
        return (
          <button
            key={i}
            onClick={() => {
              useFileStore.getState().openPreviewWithContent(alt, src, "image");
            }}
            className="block rounded-md overflow-hidden border border-white/20 hover:border-white/50 transition-colors cursor-pointer"
            title="Click to view full size"
            aria-label={`View image ${i + 1} full size`}
          >
            <img
              src={src}
              alt={alt}
              className="w-24 h-24 object-cover"
            />
          </button>
        );
      })}
    </div>
  );
}
