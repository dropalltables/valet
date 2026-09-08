// @novnc/novnc ships no types. Only the surface this app uses is declared.
declare module '@novnc/novnc' {
  export type RFBCredentials = { username?: string; password?: string; target?: string }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket | RTCDataChannel,
      options?: { credentials?: RFBCredentials; shared?: boolean; repeaterID?: string; wsProtocols?: string[] },
    )
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    showDotCursor: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    sendCredentials(credentials: RFBCredentials): void
    focus(): void
    blur(): void
  }
}
