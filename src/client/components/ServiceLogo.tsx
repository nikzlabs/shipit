/**
 * The vendor mark ShipIt draws beside a service name.
 *
 * `ServiceCard` used to draw the service's **initial** here, on the reasoning
 * that "the catalogue carries no artwork, and a letter is honest about that".
 * The letter was honest and it was also unhelpful: a column of `A` `O` `D` `G`
 * `O` `V` `O` tiles asks the reader to decode the first character of a name they
 * are already reading one control to the right, and three of the seven services
 * start with the same letter. A brand mark is the one thing on the row that can
 * be recognised without reading, which is the whole job of an avatar.
 *
 * **A brand glyph is the sanctioned exception to "no hardcoded SVG"** — the same
 * exception `SettingsIntegrations.tsx`'s `LinearLogo` takes, and for the same
 * reason: Phosphor is a set of generic UI symbols and has no vendor logos. The
 * design language's rule is about *icons* — anything labelling an action, a
 * status or a row — and a logo is neither drawn nor chosen; it is quoted.
 *
 * **Every mark is monochrome, in `currentColor`.** Not a compromise with the
 * multi-theme rule but the accurate rendering: six of these seven vendors publish
 * a single-colour mark (Anthropic `#191919`, Vercel `#000`, Z.ai `#2D2D2D`,
 * OpenRouter `#94A3B8`, OpenCode `#000`, OpenAI black), so the only thing brand
 * colour would add to the column is DeepSeek's blue — one coloured tile among
 * six grey ones, which reads as a rendering bug rather than as branding.
 * Drawing them all in
 * the caller's text colour also means they stay legible in every theme, which a
 * hardcoded `#000` would not.
 *
 * ## Provenance
 *
 * Paths are Simple Icons' (CC0-1.0, so copyable without attribution machinery),
 * read from `simple-icons@16.28.0` on 2026-08-14 (OpenCode's from the same
 * version on 2026-08-17) — except OpenAI's, which that version no longer ships
 * and which comes from `simple-icons@11.14.0`. All are
 * 24×24. The marks themselves remain their owners' trademarks; they are used
 * here to identify the service a credential belongs to, which is the use
 * trademark law leaves open.
 *
 * **The map is total; the fallback is for ids that are not services.** A first
 * cut made {@link SERVICE_MARKS} `Partial`, so a service added before its
 * artwork would quietly fall back to a letter — and then pinned "every service
 * has a mark" in a test, which fails that same build. Cross-backend review found
 * the contradiction. A total `Record<ServiceId, string>` is the version worth
 * having: adding a service without a mark is a *compile* error naming the
 * missing id, which beats a green build and a letter nobody notices. The
 * fallback keeps its job regardless, because `ServiceDef.id` is a bare `string`
 * — an id from outside the catalogue union still renders something.
 */

import { ICON_SIZE } from "../design-tokens.js";
import type { ServiceId } from "../../server/shared/catalogue/index.js";

/**
 * All this component needs of a service: which one it is, and what it is called
 * when there is no mark for it.
 *
 * Deliberately narrower than `ServiceDef`, which structurally satisfies it — the
 * pickers never hold one. A model row on the wire carries `serviceId` and
 * `serviceName` and nothing else about the service, and making the logo demand a
 * catalogue lookup at every menu row would be a lookup that can *fail*, for a
 * glyph.
 */
export interface ServiceIdentity {
  id: string;
  name: string;
}

/**
 * One 24×24 path per service. `Record` rather than `Partial<Record>` and keyed
 * on `ServiceId` rather than `string`, so a renamed id, a typo, and a service
 * added without a mark are all compile errors rather than a tile that silently
 * falls back to a letter.
 */
const SERVICE_MARKS: Record<ServiceId, string> = {
  anthropic:
    "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  openai:
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  deepseek:
    "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45",
  // Z.ai's mark, which the catalogue names "GLM (Z.ai)" — the service, not the
  // model family, is what an avatar identifies.
  zai:
    "M12.606 1.806l-1.677 2.388c-0.258 0.374-0.697 0.606-1.161 0.606h-9.162V1.794C0.594 1.806 12.606 1.806 12.606 1.806zM24 1.806L9.6 22.206 0 22.206 14.4 1.806zM11.394 22.206l1.69-2.4c0.258-0.374 0.697-0.606 1.161-0.606h9.149v3.006H11.394z",
  openrouter:
    "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
  vercel: "m12 1.608 12 20.784H0Z",
  // OpenCode's mark (docs/272), from `simple-icons@16.28.0` — the same CC0-1.0
  // source and the same 24×24 grid as the rows above.
  opencode: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
  // xAI's mark (docs/274), from `simple-icons@16.28.0` — the same CC0-1.0
  // source and the same 24×24 grid as the rows above.
  xai: "M6.469 8.776L16.512 23h-4.464L2.005 8.776zM4.100 15.550L6.343 18.727 4.101 21.900H2.000zM19.500 8.776L14.500 15.850 12.259 12.673 17.259 5.600H19.500zM17.000 2.100L14.757 5.277H12.516L14.759 2.100z",
};

/**
 * A service's mark at `size`, or its initial where the catalogue has outrun the
 * artwork.
 *
 * `aria-hidden` in both branches, and not an oversight: every call site puts the
 * service's **name** immediately beside it, so a mark that announced itself
 * would make a screen reader read the same service twice. Callers that ever draw
 * one alone must supply the name themselves.
 */
export function ServiceLogo({
  service,
  size = ICON_SIZE.XS,
}: {
  service: ServiceIdentity;
  /** Defaults to `ICON_SIZE.XS` (12px) — the size that fits the 20px card tile. */
  size?: number;
}) {
  // `ServiceDef.id` is a bare `string` on the type; the cast is the same bridge
  // `ServicesPanel`'s `HarnessSupportCell` makes for `AgentOption.id`. The map
  // is total over `ServiceId`, so the cast is also the only way `path` can come
  // back undefined — which is exactly the case the letter below is for.
  const path = SERVICE_MARKS[service.id as ServiceId] as string | undefined;

  if (!path) {
    return (
      <span aria-hidden="true" className="text-[10px] font-semibold">
        {service.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}
