export interface Tile { id: string; type: string; w: number; h: number; x?: number; y?: number; config: Record<string, any> }
export interface Group { id: string; name: string; layout: string; collapsed: boolean; pack?: boolean; tiles: Tile[] }
export interface Tab { id: string; name: string; emoji: string; groups: Group[] }
export interface Dashboard { revision: number; tabs: Tab[] }

export interface Snapshot { id: string; ok: boolean; ts: number | null; checkedAt: number; error: string | null; data: any }
export interface IntegrationInfo { id: string; type: string; name: string; enabled: boolean; url?: string; intervalSeconds?: number; hasKey?: boolean; insecureTls?: boolean }
export interface IntegrationType { id: string; name: string; description: string; urlHint: string; keyLabel: string }
export interface CameraInfo { id: string; name: string }
export interface IconHit { ref: string; label: string; preview: string }
