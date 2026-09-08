'use client'

import { toast } from 'sonner'
import { errorMessage } from './api'

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}
