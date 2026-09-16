[ShipIt] The last turn ended without a status-card update, so the card is marked stale.

{{OFFERS}}

Call `session_status` once, and do nothing else this turn: pass the fields that changed, or call it with no arguments to confirm the card exactly as it stands. If the turn that just ran did something worth saying, pass `lastTurn` as well — it is cleared by any call that omits it.
