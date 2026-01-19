export interface IEntityAdapter<TRaw, TUnified> {
  mapToUnified(raw: TRaw): TUnified;
}
