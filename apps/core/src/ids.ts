import { customAlphabet } from 'nanoid'

/** Lowercase alphanumerics only: ids end up in container names, DNS names, and branch names. */
export const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)
export const shortHex = customAlphabet('0123456789abcdef', 4)
