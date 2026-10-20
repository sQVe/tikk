export type Result<Value, Reason> = { ok: true; value: Value } | { ok: false; reason: Reason };
