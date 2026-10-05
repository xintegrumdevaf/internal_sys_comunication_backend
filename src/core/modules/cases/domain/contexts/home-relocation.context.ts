/**
 * Contexto tipado para el flujo de traslado / cambio de domicilio (HOME_RELOCATION).
 */
export type HomeRelocationContext = {
  client?: {
    nationalId: string;
    fullName: string;
  };
  contract?: {
    id: string;
    sector?: string;
    address?: string;
    routerModel?: string;
  };
  relocationDetails?: {
    newAddress?: string;
    references?: string;
    mapLocation?: string;
  };
  ragAnswer?: string;
  lastSearchedNationalId?: string;
  clientNotFound?: boolean;
};
