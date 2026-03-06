// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown listener for lightbox escape
import { useEffect, useState } from "react";
import { FileIcon as PhFileIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { ChatMessageImage, ChatMessageFile } from "./MessageList.js";

/** Full-screen lightbox overlay for viewing an image at full size. */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label="Image preview"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white text-3xl z-10"
        aria-label="Close preview"
      >
        &times;
      </button>
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/** Render file attachment chips on a message bubble. */
export function MessageFileAttachments({ files }: { files: ChatMessageFile[] }) {
  return (
    <div className="flex gap-1.5 flex-wrap mt-2" data-testid="message-files">
      {files.map((f, i) => {
        const fileName = f.path.split("/").pop() ?? f.path;
        const lineRange = f.startLine && f.endLine ? ` L${f.startLine}-${f.endLine}` : "";
        return (
          <span
            key={`${f.path}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-white/10 border border-white/20 rounded text-xs"
            title={f.path}
          >
            <PhFileIcon size={ICON_SIZE.XS} className="shrink-0 opacity-60" />
            <span className="truncate max-w-[150px]">{fileName}</span>
            {lineRange && <span className="opacity-60">{lineRange}</span>}
          </span>
        );
      })}
    </div>
  );
}

/** Render inline image thumbnails for a user message. */
export function MessageImages({ images, isUserMessage }: { images: ChatMessageImage[]; isUserMessage: boolean }) {
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

  return (
    <>
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
        />
      )}
      <div className={`flex gap-2 flex-wrap ${images.length > 0 && isUserMessage ? "mt-2" : "mb-2"}`} data-testid="message-images">
        {images.map((img, i) => {
          const src = `data:${img.mediaType};base64,${img.data}`;
          const alt = `Attached image ${i + 1}`;
          return (
            <button
              key={i}
              onClick={() => setLightboxImage({ src, alt })}
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
    </>
  );
}
