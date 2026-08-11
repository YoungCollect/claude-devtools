/**
 * A transport response is safe to display only while its key still matches
 * the active selection. This derivation prevents a previously revealed record
 * (including credential-bearing headers) from surviving the synchronous render
 * between a selection change and the next masked fetch completing.
 */
export interface KeyedTransportDetail<T> {
  transportId: string;
  value: T;
}

export function transportDetailForId<T>(
  transportId: string,
  loaded: KeyedTransportDetail<T> | undefined,
): T | undefined {
  return loaded?.transportId === transportId ? loaded.value : undefined;
}
