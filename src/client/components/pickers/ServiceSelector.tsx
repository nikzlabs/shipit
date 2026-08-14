/**
 * docs/261 phase 6 (req 11) — **who pays for this**, as a control.
 *
 * The Reviewer tab already *reported* the service and its billing mode, on a
 * line of prose and again as group headers inside the model menu. Req 11 is
 * about choosing: the user picks the service, sees on the row itself whether a
 * subscription or an API key pays for it, and only then reads a list of models
 * — which is also what keeps that list bounded as the catalogue grows (req 12).
 *
 * The unit is the `(service, billing mode)` pair, never a service alone: two
 * modes of one service are two different things to a user asking who pays, and
 * a subscription may offer fewer models than the key does (docs/252 req 5).
 *
 * Deliberately NOT rendered in the composer — see `requirements.md`'s
 * 2026-08-11 receipt. Its width is contested and it is touched every turn; req
 * 13 binds it to the same *controls*, not to a third one.
 */

import { BillingModePill } from "../BillingModePill.js";
import { ServiceLogo } from "../ServiceLogo.js";
import { Picker, PickerOption } from "./Picker.js";
import { serviceKeyOf, type ServiceChoice } from "./model-choice.js";

export function ServiceSelector({
  services,
  selected,
  onChange,
  disabled,
  idPrefix,
  fallbackLabel = "No service",
}: {
  services: ServiceChoice[];
  /** The pair currently in force, or undefined when nothing resolves yet. */
  selected: { serviceId: string; billingMode: string } | undefined;
  onChange: (service: ServiceChoice) => void;
  disabled?: boolean;
  /** Namespaces this control's test ids — a surface may hold two of them. */
  idPrefix: string;
  /**
   * What to name when the selection is not in the list — a pin whose credential
   * went away. Callers pass the pinned service's raw id, which is a worse label
   * than a name and a great deal better than a control that reads as empty
   * while the server still holds a pin.
   */
  fallbackLabel?: string;
}) {
  const selectedKey = selected ? serviceKeyOf(selected) : undefined;
  const current = services.find((s) => serviceKeyOf(s) === selectedKey);

  return (
    <Picker
      label={current?.serviceName ?? fallbackLabel}
      {...(current
        ? {
            /*
              The vendor's mark, in the slot the reasoning control's brain uses
              — the same one Settings → Services draws on the card. Only when a
              service actually resolves: `fallbackLabel` names a pin whose
              credential went away, and a mark beside "No service" would be a
              logo for nothing.
            */
            icon: <ServiceLogo service={{ id: current.serviceId, name: current.serviceName }} />,
          }
        : {})}
      ariaLabel={`Service for ${idPrefix}`}
      triggerTestId={`${idPrefix}-service-trigger`}
      menuTestId={`${idPrefix}-service-menu`}
      menuWidth="w-64"
      // No `services.length === 0` clause: an empty list renders no control at
      // all (req 14), which is what this used to try to say with `disabled`.
      disabled={disabled}
    >
      {services.map((service) => {
        const key = serviceKeyOf(service);
        return (
          <PickerOption
            key={key}
            label={service.serviceName}
            leading={
              <ServiceLogo service={{ id: service.serviceId, name: service.serviceName }} />
            }
            selected={key === selectedKey}
            onSelect={() => onChange(service)}
            testId={`${idPrefix}-service-option-${key}`}
            /*
              The pill, not a word in the label. It is the same component the
              service card and the model menu's group header carry, so the three
              cannot drift — and req 11's question is answered on the row that
              acts on it rather than in prose above the control.
            */
            trailing={<BillingModePill billingMode={service.billingMode} />}
          />
        );
      })}
    </Picker>
  );
}
