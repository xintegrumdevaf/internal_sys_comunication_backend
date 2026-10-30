export interface StoredMedia {
  buffer: Buffer;
  contentType: string | null;
  filename?: string | null;
  filePath?: string;
}

export interface EnsureStoredMediaOptions {
  mimeType?: string | null;
  filename?: string | null;
}

export interface MediaStoragePort {
  /**
   * Obtiene un archivo multimedia almacenado previamente (desde caché L1 o disco local).
   * Retorna `null` si aún no se encuentra persistido localmente.
   */
  get(mediaTarget: string): Promise<StoredMedia | null>;

  /**
   * Guarda de forma permanente (retención indefinida) el binario multimedia y su metadata en disco local.
   */
  save(
    mediaTarget: string,
    buffer: Buffer,
    contentType?: string | null,
    filename?: string | null,
  ): Promise<StoredMedia>;

  /**
   * Garantiza que un archivo multimedia (`mediaId` de Meta o URL de Zernio/externa) esté
   * descargado y persistido en disco local. Si ya existe en disco, lo devuelve inmediatamente
   * sin realizar llamadas de red.
   */
  ensureStored(
    mediaTarget: string,
    options?: EnsureStoredMediaOptions,
  ): Promise<StoredMedia | null>;
}

