/**
 * A transport response belongs on screen only while its key still matches the
 * active selection. This prevents the previous request from flashing during
 * the synchronous render before the next fetch completes.
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
