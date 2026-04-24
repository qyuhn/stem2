'use client'

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { OfficeState, type GatewaySreState } from '@/lib/pixel-office/engine/officeState'
import { renderFrame } from '@/lib/pixel-office/engine/renderer'
import { buildGatewayUrl } from "@/lib/gateway-url"
import type { EditorRenderState, ContributionData, ExerciseOverlayRender, ExerciseMarkerRender } from '@/lib/pixel-office/engine/renderer'
import { syncAgentsToOffice, AgentActivity } from '@/lib/pixel-office/agentBridge'
import { EditorState } from '@/lib/pixel-office/editor/editorState'
import {
  paintTile, placeFurniture, removeFurniture, moveFurniture,
  rotateFurniture, toggleFurnitureState, canPlaceFurniture,
  expandLayout, getWallPlacementRow,
} from '@/lib/pixel-office/editor/editorActions'
import type { ExpandDirection } from '@/lib/pixel-office/editor/editorActions'
import { TILE_SIZE } from '@/lib/pixel-office/constants'
import { TileType, EditTool, CharacterState } from '@/lib/pixel-office/types'
import type { TileType as TileTypeVal, FloorColor, OfficeLayout, PlacedFurniture } from '@/lib/pixel-office/types'
import { getCatalogEntry, isRotatable } from '@/lib/pixel-office/layout/furnitureCatalog'
import { createDefaultLayout, migrateLayoutColors, serializeLayout } from '@/lib/pixel-office/layout/layoutSerializer'
import {
  playDoneSound,
  unlockAudio,
  setSoundEnabled,
  isSoundEnabled,
  playHacSound,
  playLessonAudio,
} from '@/lib/pixel-office/notificationSound'

import { loadCharacterPNGs, loadWallPNG } from '@/lib/pixel-office/sprites/pngLoader'
import { useI18n } from '@/lib/i18n'
import { EditorToolbar } from './components/EditorToolbar'
import { EditActionBar } from './components/EditActionBar'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function formatMs(ms: number): string {
  if (!ms) return '-'
  if (ms < 1000) return ms + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

// Morse Code Component với âm thanh local
// Morse Code Component với âm thanh local (Real-time Morse Sound)
function MorseCodeComponent({ morsePlaintext, setMorsePlaintext, morseResult, setMorseResult }: {
  morsePlaintext: string
  setMorsePlaintext: React.Dispatch<React.SetStateAction<string>>
  morseResult: string
  setMorseResult: React.Dispatch<React.SetStateAction<string>>
}) {
  const audioCtxRef = useRef<AudioContext | null>(null)

  // Hàm phát âm thanh Morse chuẩn
  const playMorseTone = useCallback((char: string) => {
    try {
      // Khởi tạo AudioContext nếu chưa có (vượt policy của trình duyệt)
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      }
      
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') {
        ctx.resume()
      }

      const oscillator = ctx.createOscillator()
      const gainNode = ctx.createGain()

      // Tần số 600Hz nghe êm tai, chuẩn tín hiệu Morse
      oscillator.frequency.value = 600
      oscillator.type = 'sine'

      // . (dot) dài 80ms, - (dash) dài gấp 3 lần (240ms)
      const dotDuration = 0.08
      const duration = char === '.' ? dotDuration : dotDuration * 3

      // Dùng linearRamp để Fade-in/Fade-out 10ms (chống tiếng lụp bụp/click ở loa)
      const now = ctx.currentTime
      gainNode.gain.setValueAtTime(0, now)
      gainNode.gain.linearRampToValueAtTime(1, now + 0.01)
      gainNode.gain.setValueAtTime(1, now + duration - 0.01)
      gainNode.gain.linearRampToValueAtTime(0, now + duration)

      oscillator.connect(gainNode)
      gainNode.connect(ctx.destination)

      oscillator.start(now)
      oscillator.stop(now + duration)
    } catch (e) {
      console.error('Audio error:', e)
    }
  }, [])

  // Dọn dẹp bộ nhớ Audio khi tắt Component
  useEffect(() => {
    return () => {
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close()
        audioCtxRef.current = null
      }
    }
  }, [])

  // Bắt sự kiện gõ phím NGAY LẬP TỨC trên ô input
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.repeat) return // Chặn phát liên tục nếu giữ lỳ phím
    
    if (e.key === '.') {
      unlockAudio() // Gọi hàm từ thư viện của bạn để chắc chắn audio được cấp quyền
      playMorseTone('.')
    } else if (e.key === '-') {
      unlockAudio()
      playMorseTone('-')
    }
  }

  const morseCode: Record<string, string> = {
    'A': '.-', 'B': '-...', 'C': '-.-.', 'D': '-..', 'E': '.', 'F': '..-.',
    'G': '--.', 'H': '....', 'I': '..', 'J': '.---', 'K': '-.-', 'L': '.-..',
    'M': '--', 'N': '-.', 'O': '---', 'P': '.--.', 'Q': '--.-', 'R': '.-.',
    'S': '...', 'T': '-', 'U': '..-', 'V': '...-', 'W': '.--', 'X': '-..-',
    'Y': '-.--', 'Z': '--..',
    '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
    '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
    ' ': ' '
  }

  const handleSubmit = () => {
    console.log('Morse Plaintext:', morsePlaintext)
    if (morsePlaintext) {
      // Logic: Đúng input morse "-- .- .... --- .-" (M-A-H-O-A)
      const normalized = morsePlaintext.trim().replace(/\s+/g, ' ').toLowerCase()
      if (normalized === '-- .- .... --- .-') {
        setMorseResult('{matmatruongson}')
      } else {
        const result = morsePlaintext.toUpperCase().split('').map(c => morseCode[c] || c).join(' ')
        setMorseResult(result)
      }
    }
  }

  return (
    <div className="mt-[2%] flex flex-col gap-3">
      <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
        <input
          value={morsePlaintext}
          onChange={(event) => setMorsePlaintext(event.target.value)}
          onKeyDown={handleInputKeyDown} // <-- Thêm sự kiện bắt âm thanh tại đây
          placeholder="Nhập mã morse"
          className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
          autoComplete="off"
        />
      </div>
      <div className="w-1/3 mx-auto">
        <button
          type="button"
          onClick={handleSubmit}
          className="relative w-full"
          style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
        >
          <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
        </button>
      </div>
      {morseResult && (
        <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
          {morseResult}
        </div>
      )}
    </div>
  )
}

type ReleaseInfo = {
  tag: string
  name: string
  publishedAt: string
  body: string
  htmlUrl: string
}

type AgentStats = {
  sessionCount: number
  messageCount: number
  totalTokens: number
  todayAvgResponseMs: number
  weeklyResponseMs: number[]
  weeklyTokens: number[]
  lastActive: number | null
}

import {
  AgentCard,
  type AgentCardAgent,
  type AgentModelTestResult,
  type AgentSessionTestResult,
  type PlatformTestResult,
} from '../components/agent-card'

export type ConfigAgentCard = AgentCardAgent

function MiniSparkline({ data, width = 120, height = 24, color: fixedColor }: { data: number[]; width?: number; height?: number; color?: string }) {
  const hasData = data.some(v => v > 0)
  if (!hasData) return null
  const validValues = data.filter(v => v > 0)
  let trending: 'up' | 'down' | 'flat' = 'flat'
  if (validValues.length >= 2) {
    const last = validValues[validValues.length - 1]
    const prev = validValues[validValues.length - 2]
    trending = last > prev ? 'up' : last < prev ? 'down' : 'flat'
  }
  const color = fixedColor || (trending === 'up' ? '#f87171' : trending === 'down' ? '#4ade80' : '#f59e0b')
  const max = Math.max(...data)
  const min = Math.min(...data.filter(v => v > 0), max)
  const range = max - min || 1
  const pad = 2
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2)
    const y = v === 0 ? height - pad : (height - pad) - ((v - min) / range) * (height - pad * 2 - 2)
    return { x, y, v }
  })
  const line = pts.map(p => `${p.x},${p.y}`).join(' ')
  const area = `${pts[0].x},${height} ${line} ${pts[pts.length - 1].x},${height}`
  const id = `spark-${Math.random().toString(36).slice(2, 8)}`
  return (
    <svg width={width} height={height} className="inline-block align-middle">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      {pts.filter(p => p.v > 0).map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2} fill={color} opacity={0.9} />
      ))}
    </svg>
  )
}

/** Convert mouse event to tile coordinates */
function mouseToTile(
  clientX: number, clientY: number, canvas: HTMLCanvasElement, office: OfficeState, zoom: number, pan: { x: number; y: number }
): { col: number; row: number; worldX: number; worldY: number } {
  const rect = canvas.getBoundingClientRect()
  const x = clientX - rect.left
  const y = clientY - rect.top
  const cols = office.layout.cols
  const rows = office.layout.rows
  const mapW = cols * TILE_SIZE * zoom
  const mapH = rows * TILE_SIZE * zoom
  const offsetX = (rect.width - mapW) / 2 + pan.x
  const offsetY = (rect.height - mapH) / 2 + pan.y
  const worldX = (x - offsetX) / zoom
  const worldY = (y - offsetY) / zoom
  const col = Math.floor(worldX / TILE_SIZE)
  const row = Math.floor(worldY / TILE_SIZE)
  return { col, row, worldX, worldY }
}

/** Detect ghost border tile (expansion zone) */
function getGhostBorderDirection(col: number, row: number, cols: number, rows: number): ExpandDirection | null {
  if (row === -1) return 'up'
  if (row === rows) return 'down'
  if (col === -1) return 'left'
  if (col === cols) return 'right'
  return null
}

function getLayoutContentBounds(layout: OfficeLayout): { minCol: number; maxCol: number; minRow: number; maxRow: number } {
  let minCol = layout.cols - 1
  let maxCol = 0
  let minRow = layout.rows - 1
  let maxRow = 0
  let hasContent = false

  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      if (layout.tiles[r * layout.cols + c] === TileType.VOID) continue
      hasContent = true
      if (c < minCol) minCol = c
      if (c > maxCol) maxCol = c
      if (r < minRow) minRow = r
      if (r > maxRow) maxRow = r
    }
  }

  for (const f of layout.furniture) {
    const entry = getCatalogEntry(f.type)
    const w = Math.max(1, entry?.footprintW ?? 1)
    const h = Math.max(1, entry?.footprintH ?? 1)
    hasContent = true
    if (f.col < minCol) minCol = f.col
    if (f.col + w - 1 > maxCol) maxCol = f.col + w - 1
    if (f.row < minRow) minRow = f.row
    if (f.row + h - 1 > maxRow) maxRow = f.row + h - 1
  }

  if (!hasContent) return { minCol: 0, maxCol: layout.cols - 1, minRow: 0, maxRow: layout.rows - 1 }
  return {
    minCol: Math.max(0, minCol),
    maxCol: Math.min(layout.cols - 1, maxCol),
    minRow: Math.max(0, minRow),
    maxRow: Math.min(layout.rows - 1, maxRow),
  }
}

const DESKTOP_CANVAS_ZOOM = 2.5
const MOBILE_CANVAS_ZOOM = 1.9
const MOBILE_MIN_ZOOM = 0.55
const MOBILE_MAX_ZOOM = 6
const MOBILE_FIT_PADDING_PX = 2
const MOBILE_TOP_EXTRA_TILES = 0.5
const MOBILE_VIEW_NUDGE_Y_PX = -10
const DESKTOP_TOP_EXTRA_TILES = 1.0
const DESKTOP_TOP_SAFE_PADDING_PX = 4
const CODE_SNIPPET_LIFETIME_SEC = 5.5
const SRE_BLACKWORD_MAX_FLOAT_DIST_PX = 320
const FLOATING_TICK_INTERVAL_DESKTOP_MS = 48
const FLOATING_TICK_INTERVAL_MOBILE_MS = 32
const AGENT_ACTIVITY_POLL_INTERVAL_MS = 1000
const GATEWAY_HEALTH_POLL_INTERVAL_MS = 10000
const GATEWAY_DEGRADED_LATENCY_MS = 1500
const GATEWAY_SRE_DOWN_FAIL_THRESHOLD = 2
const GATEWAY_SRE_DEGRADED_THRESHOLD = 2
const GATEWAY_SRE_RECOVERY_SUCCESS_THRESHOLD = 2
const SINGLE_PLAYER_KEYBOARD_MODE = true
const PLAYER_CHARACTER_ID = 1
const PIXEL_OFFICE_FOCUS_ONLY = true
const EXERCISE_PROGRESS_KEY = 'pixel-office-exercise-progress-v1'

type ExerciseTask = {
  id: number
  title: string
  content: string
  dialogue: string[]
  targetUid?: string
  targetFallback?: { col: number; row: number; w: number; h: number }
}

const GAMEPLAY_SKILL_OPTIONS = [
  'Giải mã hóa bằng từ điển',
  'Giải mã hóa bằng XOR',
  'Giải mã bằng khóa chạy',
  'Mã hóa bằng khóa chạy',
  'Biến ma trận số thành ảnh',
  'Biến ma trận thành ma trận xoắn ốc',
  'Phân cụm ma trận',
  'Dò mật khẩu dựa trên từ vựng',
  'Tạo mã morse',
  'Dò tìm mật khẩu online',
  'Dò mật khẩu theo quy tắc',
  'Dò mật khẩu từ bàn phím',
  'Mã độc keylogger',
  'Chặn bắt gói tin',
  'Phát lại gói tin',
  'Đánh giá tên miền giả mạo',
  'Tạo website giả mạo',
  'Mã độc capcha',
] as const

// Skills that can only be dropped together
const CAPCHA_SKILL_GROUP = ['Đánh giá tên miền giả mạo', 'Tạo website giả mạo', 'Mã độc capcha'] as const

const EXERCISE_TASKS: ExerciseTask[] = [
  {
    id: 1,
    title: 'Mật mã ứng dụng',
    content: 'Mã morse',
    dialogue: ['Đây là bài khởi động về mã hóa thông tin.', 'Nhiệm vụ của bạn là giải mã chuỗi Morse để lấy manh mối.'],
    targetUid: 'library-r',
  },
  {
    id: 2,
    title: 'Giấu tin',
    content: 'QR',
    dialogue: ['Có một thông tin đang bị giấu trong mã QR.', 'Hãy tìm cách quét và trích xuất đúng dữ liệu ẩn.'],
    targetUid: 'painting-l2',
  },
  {
    id: 3,
    title: 'Wifi',
    content: 'Khai thác wifi công cộng',
    dialogue: ['Mạng WiFi công cộng luôn là điểm yếu phổ biến.', 'Bạn cần phân tích và khai thác đúng kỹ thuật để đi tiếp.'],
    targetUid: 'pc-l1',
  },
  {
    id: 4,
    title: 'Mật khẩu',
    content: 'Mật khẩu',
    dialogue: ['Mật khẩu đang bị cấu hình yếu.', 'Hãy khai thác điểm yếu đó để thu thập thông tin đăng nhập.'],
    targetUid: 'pc-l2',
  },
  {
    id: 5,
    title: 'Camera tường',
    content: 'Tìm mật khẩu chính xác của camera góc tường',
    dialogue: ['Thiết bị camera ở góc tường chứa tài khoản quản trị.', 'Tìm đúng mật khẩu để mở khóa quyền truy cập.'],
    targetFallback: { col: 1.05, row: -0.22, w: 0.575, h: 0.575 },
  },
  {
    id: 6,
    title: 'Camera bàn',
    content: 'Điều khiển thao túng camera ở bàn',
    dialogue: ['Sau khi có quyền truy cập, bước tiếp theo là điều khiển camera.', 'Bạn cần thao túng góc nhìn theo yêu cầu nhiệm vụ.'],
    targetUid: 'camera-r',
  },
  {
    id: 7,
    title: 'Web',
    content: 'Giả mạo trang web',
    dialogue: ['Mục tiêu tiếp theo là tạo trang giả mạo.', 'Tái tạo giao diện đủ giống để thu thập dữ liệu mục tiêu.'],
    targetUid: 'pc-l3',
  },
  {
    id: 8,
    title: 'Mã độc',
    content: 'Key Logger',
    dialogue: ['Bài cuối cùng tập trung vào mã độc ghi phím.', 'Hoàn thành triển khai và kiểm tra thu thập dữ liệu thành công.'],
    targetUid: 'pc-l4',
  },
]

type ExerciseBounds = { col: number; row: number; w: number; h: number }

function resolveExerciseBounds(task: ExerciseTask, furniture: PlacedFurniture[]): ExerciseBounds | null {
  if (task.targetUid) {
    const item = furniture.find((f) => f.uid === task.targetUid)
    if (item) {
      const entry = getCatalogEntry(item.type)
      if (entry) {
        return { col: item.col, row: item.row, w: entry.footprintW, h: entry.footprintH }
      }
      return { col: item.col, row: item.row, w: 1, h: 1 }
    }
  }
  if (task.targetFallback) {
    return task.targetFallback
  }
  return null
}

let cachedOfficeState: OfficeState | null = null
let cachedEditorState: EditorState | null = null
let cachedSavedLayout: OfficeLayout | null = null
let cachedPan: { x: number; y: number } = { x: 0, y: 0 }
let cachedIsEditMode = false
let spriteAssetsPromise: Promise<void> | null = null
let cachedAgents: AgentActivity[] = []
let cachedAgentIdMap = new Map<string, number>()
let cachedNextCharacterId = 1
let cachedPrevAgentStates = new Map<string, string>()

export default function PixelOfficePage() {
  const { t, locale } = useI18n()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const officeRef = useRef<OfficeState | null>(null)
  const editorRef = useRef<EditorState>(cachedEditorState ?? new EditorState())
  const agentIdMapRef = useRef<Map<string, number>>(new Map(cachedAgentIdMap))
  const nextIdRef = useRef<{ current: number }>({ current: cachedNextCharacterId })
  const zoomRef = useRef<number>(DESKTOP_CANVAS_ZOOM)
  const panRef = useRef<{ x: number; y: number }>(cachedPan)
  const savedLayoutRef = useRef<OfficeLayout | null>(cachedSavedLayout)
  const animationFrameIdRef = useRef<number | null>(null)
  const officeReadyRef = useRef<boolean>(false)
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map(cachedPrevAgentStates))
  const seenSubagentEventKeysRef = useRef<Map<string, number>>(new Map())

  const [agents, setAgents] = useState<AgentActivity[]>(cachedAgents)
  const [hoveredAgentId, setHoveredAgentId] = useState<number | null>(null)
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const agentStatsRef = useRef<Map<string, AgentStats>>(new Map())
  const configAgentsRef = useRef<Map<string, ConfigAgentCard>>(new Map())
  const contributionsRef = useRef<ContributionData | null>(null)
  const photographRef = useRef<HTMLImageElement | null>(null)
  const wallCameraRef = useRef<HTMLImageElement | null>(null)
  const deskCameraRef = useRef<HTMLImageElement | null>(null)
  const exerciseArrowRef = useRef<HTMLImageElement | null>(null)
  const leftRouterRef = useRef<HTMLImageElement | null>(null)
  const rightRouterRef = useRef<HTMLImageElement | null>(null)
  const gatewayRef = useRef<{ port: number; token?: string; host?: string }>({ port: 18789 })
  const gatewayHealthyRef = useRef<boolean>(true)
  const gatewaySreRef = useRef<{
    status: GatewaySreState
    error: string | null
    responseMs: number | null
    checkedAt: number | null
  }>({ status: 'unknown', error: null, responseMs: null, checkedAt: null })
  const gatewayDownStreakRef = useRef(0)
  const gatewayDegradedStreakRef = useRef(0)
  const gatewayHealthyStreakRef = useRef(0)
  const providerAccessModeRef = useRef<Record<string, 'auth' | 'api_key'>>({})
  const providersRef = useRef<Array<{ id: string; api: string; models: Array<{ id: string; name: string; contextWindow?: number }>; usedBy: Array<{ id: string; emoji: string; name: string }> }>>([])
  const [isEditMode, setIsEditMode] = useState(cachedIsEditMode)
  const [soundOn, setSoundOn] = useState(true)
  const [editorTick, setEditorTick] = useState(0)
  const [officeReady, setOfficeReady] = useState(false)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [fullscreenPhoto, setFullscreenPhoto] = useState(false)
  const [showModelPanel, setShowModelPanel] = useState(false)
  const [showTokenRank, setShowTokenRank] = useState(false)
  const [broadcasts, setBroadcasts] = useState<Array<{ id: number; emoji: string; text: string }>>([])
  const [showActivityHeatmap, setShowActivityHeatmap] = useState(false)
  const activityHeatmapRef = useRef<Array<{ agentId: string; grid: number[][] }> | null>(null)
  const [showPhonePanel, setShowPhonePanel] = useState(false)
  const [versionInfo, setVersionInfo] = useState<ReleaseInfo | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)
  const [versionLoadFailed, setVersionLoadFailed] = useState(false)
  const [showIdleRank, setShowIdleRank] = useState(false)
  const [cachedModelTestResults, setCachedModelTestResults] = useState<Record<string, AgentModelTestResult | null> | null>(null)
  const [cachedPlatformTestResults, setCachedPlatformTestResults] = useState<Record<string, PlatformTestResult | null> | null>(null)
  const [cachedSessionTestResults, setCachedSessionTestResults] = useState<Record<string, AgentSessionTestResult | null> | null>(null)
  const [cachedDmSessionResults, setCachedDmSessionResults] = useState<Record<string, PlatformTestResult | null> | null>(null)
  const selectedAgentOpenedAtRef = useRef(0)
  const tokenRankOpenedAtRef = useRef(0)
  const modelPanelOpenedAtRef = useRef(0)
  const fullscreenPhotoOpenedAtRef = useRef(0)
  const [subagentCreatorInfo, setSubagentCreatorInfo] = useState<{ parentAgentId: string; x: number; y: number } | null>(null)
  const [serverTooltip, setServerTooltip] = useState<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 })
  const idleRankRef = useRef<Array<{ agentId: string; onlineMinutes: number; activeMinutes: number; idleMinutes: number; idlePercent: number }> | null>(null)
  const floatingCommentsRef = useRef<Array<{ key: string; text: string; x: number; y: number; opacity: number }>>([])
  const floatingCodeRef = useRef<Array<{ key: string; text: string; x: number; y: number; opacity: number; kind?: 'default' | 'sre' }>>([])
  const floatingTickUpdatedAtRef = useRef<number>(0)
  const [floatingTick, setFloatingTick] = useState(0)
  const [isMobileViewport, setIsMobileViewport] = useState(false)

  const [exerciseCompletedIds, setExerciseCompletedIds] = useState<number[]>([])
  const [activeExerciseTaskId, setActiveExerciseTaskId] = useState<number | null>(null)
  const [exerciseScene, setExerciseScene] = useState<'dialogue' | 'gameplay' | null>(null)
  const [dialogueLineIndex, setDialogueLineIndex] = useState(0)
  const [dialogueTypedLength, setDialogueTypedLength] = useState(0)
  const [storyLinesByTaskId, setStoryLinesByTaskId] = useState<Record<number, string[]>>({})
  const [droppedGameplaySkill, setDroppedGameplaySkill] = useState<string | null>(null)
  const [gameplayFlagInput, setGameplayFlagInput] = useState('')
  const nearExerciseTaskIdRef = useRef<number | null>(null)

  // Giải mã hóa bằng từ điển inputs
  const [dictionaryDecodeText, setDictionaryDecodeText] = useState('')
  const [dictionaryDecodeResult, setDictionaryDecodeResult] = useState('')

  // Giải mã hóa bằng XOR inputs
  const [xorHoaCiphertext, setXorHoaCiphertext] = useState('')
  const [xorHoaDataFormat, setXorHoaDataFormat] = useState<string>('hex')
  const [xorHoaKey, setXorHoaKey] = useState('')
  const [xorHoaKeyType, setXorHoaKeyType] = useState<string>('hex')
  const [xorHoaDecryptResult, setXorHoaDecryptResult] = useState('')

  // Giải mã bằng khóa chạy inputs
  const [runningKeyCiphertext, setRunningKeyCiphertext] = useState('')
  const [runningKeyKey, setRunningKeyKey] = useState('')
  const [runningKeyDecryptResult, setRunningKeyDecryptResult] = useState('')

  // Mã hóa bằng khóa chạy inputs
  const [encryptRunningKeyPlaintext, setEncryptRunningKeyPlaintext] = useState('')
  const [encryptRunningKey, setEncryptRunningKey] = useState('')
  const [encryptRunningKeyResult, setEncryptRunningKeyResult] = useState('')

  // Biến ma trận số thành ảnh inputs
  const [matrixImageData, setMatrixImageData] = useState<number[][]>(() =>
    Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => Math.random() < 0.3 ? 1 : 0))
  )
  const [matrixImageResult, setMatrixImageResult] = useState('')

  // Mã hóa ma trận bằng cộng dồn inputs
  const [matrixCumulativeData, setMatrixCumulativeData] = useState<number[][]>(() =>
    Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => Math.random() < 0.3 ? 1 : 0))
  )
  const [matrixCumulativeResult, setMatrixCumulativeResult] = useState('')

  // Mã hóa ma trận inputs
  const [matrixEncryptData, setMatrixEncryptData] = useState<number[][]>(() =>
    Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => Math.random() < 0.3 ? 1 : 0))
  )
  const [matrixEncryptResult, setMatrixEncryptResult] = useState('')

  // Dò mật khẩu dựa trên từ vựng inputs
  const [wordlistContent, setWordlistContent] = useState(`admin
password
123456
letmein
qwerty
abc123
monkey
master
dragon
login
welcome
shadow
sunshine
princess
football
iloveyou
michael
ninja
mustang
batman`)

  // Tạo mã morse inputs
  const [morsePlaintext, setMorsePlaintext] = useState('')
  const [morseResult, setMorseResult] = useState('')

  // Dò tìm mật khẩu online inputs
  const [passwordSearchKeyword, setPasswordSearchKeyword] = useState('')
  const [passwordSearchResult, setPasswordSearchResult] = useState('')

  // Dò mật khẩu theo quy tắc inputs
  const [passwordRuleSelection, setPasswordRuleSelection] = useState('')
  const [passwordRuleResult, setPasswordRuleResult] = useState('')

  // Dò mật khẩu từ bàn phím inputs
  const [keyboardPasswordResult, setKeyboardPasswordResult] = useState('')

  // Mã độc keylogger inputs
  const [keyloggerResult, setKeyloggerResult] = useState('')

  // Chặn bắt gói tin inputs
  const [packetCaptureResult, setPacketCaptureResult] = useState('')

  // Phát lại gói tin inputs
  const [replayPacketNumber, setReplayPacketNumber] = useState('')
  const [replayField1Name, setReplayField1Name] = useState('')
  const [replayField1Value, setReplayField1Value] = useState('')
  const [replayField2Name, setReplayField2Name] = useState('')
  const [replayField2Value, setReplayField2Value] = useState('')
  const [replayField3Name, setReplayField3Name] = useState('')
  const [replayField3Value, setReplayField3Value] = useState('')
  const [replayField4Name, setReplayField4Name] = useState('')
  const [replayField4Value, setReplayField4Value] = useState('')
  const [packetReplayResult, setPacketReplayResult] = useState('')

  // Đánh giá tên miền giả mạo inputs (skill 1)
  const [fakeDomainInput, setFakeDomainInput] = useState('')
  const [domainEvaluationResult, setDomainEvaluationResult] = useState('')

  // Tạo website giả mạo inputs (skill 2)
  const [selectedFakeWebsite, setSelectedFakeWebsite] = useState('')

  // Mã độc capcha inputs
  const [capchaMalwareResult, setCapchaMalwareResult] = useState('')

  // Track multiple dropped skills
  const [droppedSkills, setDroppedSkills] = useState<string[]>([])

  // XOR data format options
  const XOR_DATA_FORMAT_OPTIONS = [
    { id: 'hex', name: 'Hex' },
    { id: 'binary', name: 'Nhị phân' },
    { id: 'decimal', name: 'Thập phân' },
  ]

  // XOR key type options
  const XOR_KEY_TYPE_OPTIONS = [
    { id: 'hex', name: 'Hex' },
    { id: 'ascii', name: 'ASCII' },
  ]

  const forceEditorUpdate = useCallback(() => setEditorTick(t => t + 1), [])

  const completedExerciseSet = useMemo(() => new Set(exerciseCompletedIds), [exerciseCompletedIds])
  const nextExerciseTaskId = useMemo(
    () => EXERCISE_TASKS.find((task) => !completedExerciseSet.has(task.id))?.id ?? null,
    [completedExerciseSet],
  )
  const activeExerciseTask = useMemo(
    () => EXERCISE_TASKS.find((task) => task.id === activeExerciseTaskId) ?? null,
    [activeExerciseTaskId],
  )
  const activeDialogueLines = useMemo(
    () => {
      if (!activeExerciseTask) return []
      const externalStory = storyLinesByTaskId[activeExerciseTask.id]
      if (externalStory && externalStory.length > 0) return externalStory
      return activeExerciseTask.dialogue ?? []
    },
    [activeExerciseTask, storyLinesByTaskId],
  )
  const activeDialogueLine = useMemo(
    () => activeDialogueLines[dialogueLineIndex] ?? '',
    [activeDialogueLines, dialogueLineIndex],
  )
  const isDialogueLineComplete = dialogueTypedLength >= activeDialogueLine.length

  useEffect(() => {
    if (dialogueLineIndex < activeDialogueLines.length) return
    setDialogueLineIndex(0)
    setDialogueTypedLength(0)
  }, [activeDialogueLines.length, dialogueLineIndex])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(EXERCISE_PROGRESS_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as number[]
      if (!Array.isArray(parsed)) return
      const validIds = parsed.filter((id) => EXERCISE_TASKS.some((task) => task.id === id))
      setExerciseCompletedIds(Array.from(new Set(validIds)).sort((a, b) => a - b))
    } catch {
      // ignore invalid local storage payload
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadStories = async () => {
      const loaded = await Promise.all(
        EXERCISE_TASKS.map(async (task) => {
          const candidates = [
            `/stories/story${task.id}.txt`,
            `/stories/story${task.id}`,
            `/stories/strory${task.id}.txt`,
            `/stories/strory${task.id}`,
          ]

          for (const url of candidates) {
            try {
              const res = await fetch(url, { cache: 'no-store' })
              if (!res.ok) continue
              const text = await res.text()
              const lines = text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
              if (lines.length > 0) {
                return [task.id, lines] as const
              }
            } catch {
              // try next candidate file name
            }
          }

          return [task.id, [] as string[]] as const
        }),
      )

      if (cancelled) return
      const map: Record<number, string[]> = {}
      for (const [id, lines] of loaded) {
        if (lines.length > 0) map[id] = lines
      }
      setStoryLinesByTaskId(map)
    }

    void loadStories()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!PIXEL_OFFICE_FOCUS_ONLY) return
    document.body.classList.add('pixel-office-focus')
    return () => {
      document.body.classList.remove('pixel-office-focus')
    }
  }, [])

  const configureSinglePlayerMode = useCallback((office: OfficeState) => {
    office.characters.clear()
    office.subagentIdMap.clear()
    office.subagentMeta.clear()
    office.setBugEnabled(false)
    office.addAgent(PLAYER_CHARACTER_ID, 0, 0, undefined, true, false)

    const player = office.characters.get(PLAYER_CHARACTER_ID)
    if (player) {
      player.manualControlled = true
      player.isActive = false
      player.state = CharacterState.IDLE
      player.wanderTimer = Number.POSITIVE_INFINITY
      player.wanderCount = 0
      player.currentTool = null
      player.label = locale === 'vi' ? 'Người chơi' : locale === 'en' ? 'Player' : '玩家'
    }

    setAgents([])
    agentIdMapRef.current.clear()
    nextIdRef.current.current = PLAYER_CHARACTER_ID + 1
    cachedAgents = []
    cachedAgentIdMap = new Map()
    cachedNextCharacterId = PLAYER_CHARACTER_ID + 1
  }, [locale])

  const markExerciseCompleted = useCallback((taskId: number) => {
    setExerciseCompletedIds((prev) => {
      if (prev.includes(taskId)) return prev
      const next = [...prev, taskId].sort((a, b) => a - b)
      localStorage.setItem(EXERCISE_PROGRESS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  useEffect(() => {
    if (exerciseScene !== 'dialogue') return
    if (!activeDialogueLine) return
    if (dialogueTypedLength >= activeDialogueLine.length) return

    const timer = window.setInterval(() => {
      setDialogueTypedLength((prev) => Math.min(prev + 1, activeDialogueLine.length))
    }, 22)

    return () => {
      window.clearInterval(timer)
    }
  }, [exerciseScene, activeDialogueLine, dialogueTypedLength])

  useEffect(() => {
    if (exerciseScene !== 'gameplay') return
    setDroppedGameplaySkill(null)
    setGameplayFlagInput('')
    // Reset Giải mã hóa bằng từ điển
    setDictionaryDecodeText('')
    setDictionaryDecodeResult('')
    // Reset Giải mã hóa bằng XOR
    setXorHoaCiphertext('')
    setXorHoaDataFormat('hex')
    setXorHoaKey('')
    setXorHoaKeyType('hex')
    setXorHoaDecryptResult('')
    // Reset Giải mã bằng khóa chạy
    setRunningKeyCiphertext('')
    setRunningKeyKey('')
    setRunningKeyDecryptResult('')
    // Reset Mã hóa bằng khóa chạy
    setEncryptRunningKeyPlaintext('')
    setEncryptRunningKey('')
    setEncryptRunningKeyResult('')
  }, [exerciseScene, activeExerciseTaskId])

  const openExerciseDialogue = useCallback((taskId: number) => {
    setActiveExerciseTaskId(taskId)
    setExerciseScene('dialogue')
    setDialogueLineIndex(0)
    setDialogueTypedLength(0)
  }, [])

  const closeExerciseScene = useCallback(() => {
    setExerciseScene(null)
    setActiveExerciseTaskId(null)
    setDialogueLineIndex(0)
    setDialogueTypedLength(0)
  }, [])

  const goExerciseGameplay = useCallback(() => {
    setExerciseScene('gameplay')
  }, [])

  const handleGameplaySubmit = useCallback(async () => {
    if (!activeExerciseTask) return
    
    // Validate flag from file
    const userFlag = gameplayFlagInput.trim()
    if (!userFlag) return
    
    try {
      const res = await fetch(`/flags/${activeExerciseTask.id}.txt`, { cache: 'no-store' })
      if (!res.ok) {
        alert('Flag chưa chính xác. Thử lại!')
        return
      }
      const correctFlag = (await res.text()).trim()
      
      if (userFlag === correctFlag) {
        markExerciseCompleted(activeExerciseTask.id)
        closeExerciseScene()
      } else {
        alert('Flag chưa chính xác. Thử lại!')
      }
    } catch {
      alert('Flag chưa chính xác. Thử lại!')
    }
  }, [activeExerciseTask, gameplayFlagInput, closeExerciseScene, markExerciseCompleted])

  const handleDialogueBack = useCallback(() => {
    if (!activeDialogueLines.length) return
    const prevIndex = Math.max(0, dialogueLineIndex - 1)
    setDialogueLineIndex(prevIndex)
    const prevLine = activeDialogueLines[prevIndex] ?? ''
    setDialogueTypedLength(prevLine.length)
  }, [activeDialogueLines, dialogueLineIndex])

  const handleDialogueNext = useCallback(() => {
    if (!activeDialogueLine) {
      goExerciseGameplay()
      return
    }
    if (!isDialogueLineComplete) {
      setDialogueTypedLength(activeDialogueLine.length)
      return
    }
    if (dialogueLineIndex < activeDialogueLines.length - 1) {
      const nextIndex = dialogueLineIndex + 1
      setDialogueLineIndex(nextIndex)
      setDialogueTypedLength(0)
      return
    }
    goExerciseGameplay()
  }, [activeDialogueLine.length, activeDialogueLines.length, dialogueLineIndex, goExerciseGameplay, isDialogueLineComplete])

  const fetchVersionInfo = useCallback(async (forceLatest = false) => {
    setVersionLoading(true)
    setVersionLoadFailed(false)
    try {
      const url = forceLatest ? '/api/pixel-office/version?force=1' : '/api/pixel-office/version'
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data || !data.tag) throw new Error('Invalid version payload')
      setVersionInfo(data)
    } catch {
      setVersionLoadFailed(true)
    } finally {
      setVersionLoading(false)
    }
  }, [])

  const refreshGatewayHealthSnapshot = useCallback(async () => {
    let rawStatus: GatewaySreState = 'down'
    let error: string | null = null
    let responseMs: number | null = null
    let checkedAt: number | null = null
    try {
      const res = await fetch('/api/gateway-health', { cache: 'no-store' })
      const data = await res.json()
      checkedAt = typeof data?.checkedAt === 'number' ? data.checkedAt : Date.now()
      responseMs = typeof data?.responseMs === 'number' ? data.responseMs : null
      error = typeof data?.error === 'string' ? data.error : null
      if (data?.status === 'healthy' || data?.status === 'degraded' || data?.status === 'down') {
        rawStatus = data.status
      } else if (!data?.ok) {
        rawStatus = 'down'
      } else if (typeof responseMs === 'number' && responseMs > GATEWAY_DEGRADED_LATENCY_MS) {
        rawStatus = 'degraded'
      } else {
        rawStatus = 'healthy'
      }
    } catch {
      rawStatus = 'down'
      error = 'fetch failed'
      checkedAt = Date.now()
    }

    const prev = gatewaySreRef.current.status
    let effective: GatewaySreState = prev

    if (rawStatus === 'down') {
      gatewayDownStreakRef.current += 1
      gatewayDegradedStreakRef.current = 0
      gatewayHealthyStreakRef.current = 0
      if (
        prev === 'unknown' ||
        prev === 'down' ||
        gatewayDownStreakRef.current >= GATEWAY_SRE_DOWN_FAIL_THRESHOLD
      ) {
        effective = 'down'
      }
    } else if (rawStatus === 'degraded') {
      gatewayDegradedStreakRef.current += 1
      gatewayDownStreakRef.current = 0
      gatewayHealthyStreakRef.current = 0
      if (
        prev === 'unknown' ||
        prev === 'degraded' ||
        gatewayDegradedStreakRef.current >= GATEWAY_SRE_DEGRADED_THRESHOLD
      ) {
        effective = 'degraded'
      }
    } else {
      gatewayHealthyStreakRef.current += 1
      gatewayDownStreakRef.current = 0
      gatewayDegradedStreakRef.current = 0
      if (prev === 'down' || prev === 'degraded') {
        if (gatewayHealthyStreakRef.current >= GATEWAY_SRE_RECOVERY_SUCCESS_THRESHOLD) {
          effective = 'healthy'
        }
      } else {
        effective = 'healthy'
      }
    }

    gatewaySreRef.current = {
      status: effective,
      error,
      responseMs,
      checkedAt,
    }
    gatewayHealthyRef.current = effective !== 'down'
    officeRef.current?.updateGatewaySreState({
      status: effective,
      error,
      responseMs,
      checkedAt,
    })
  }, [])

  // Update OfficeState locale when language changes or when office finishes loading
  useEffect(() => {
    if (officeReady) {
      officeRef.current?.setLocale(locale as 'zh-TW' | 'zh' | 'en' | 'vi')
    }
  }, [locale, officeReady])

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)")
    const apply = () => setIsMobileViewport(mql.matches)
    apply()
    mql.addEventListener("change", apply)
    return () => mql.removeEventListener("change", apply)
  }, [])

  useEffect(() => {
    officeReadyRef.current = officeReady
  }, [officeReady])

  // Load saved layout and sound preference
  useEffect(() => {
    const loadLayout = async () => {
      if (cachedOfficeState) {
        officeRef.current = cachedOfficeState
        officeRef.current.setLocale(locale as 'zh-TW' | 'zh' | 'en' | 'vi')
        officeRef.current.updateGatewaySreState(gatewaySreRef.current)
        if (SINGLE_PLAYER_KEYBOARD_MODE) {
          configureSinglePlayerMode(officeRef.current)
        }
        savedLayoutRef.current = cachedSavedLayout
        editorRef.current = cachedEditorState ?? editorRef.current
        panRef.current = cachedPan
        setIsEditMode(cachedIsEditMode)
        if (!spriteAssetsPromise) {
          spriteAssetsPromise = Promise.all([loadCharacterPNGs(), loadWallPNG()]).then(() => undefined)
        }
        await spriteAssetsPromise
        setOfficeReady(true)
        return
      }
      try {
        const res = await fetch('/api/pixel-office/layout')
        const data = await res.json()
        if (data.layout) {
          const migrated = migrateLayoutColors(data.layout)
          officeRef.current = new OfficeState(
            migrated,
            locale as 'zh-TW' | 'zh' | 'en' | 'vi',
            { singlePlayerKeyboardMode: SINGLE_PLAYER_KEYBOARD_MODE }
          )
          savedLayoutRef.current = migrated
        } else {
          officeRef.current = new OfficeState(
            undefined,
            locale as 'zh-TW' | 'zh' | 'en' | 'vi',
            { singlePlayerKeyboardMode: SINGLE_PLAYER_KEYBOARD_MODE }
          )
        }
      } catch {
        officeRef.current = new OfficeState(
          undefined,
          locale as 'zh-TW' | 'zh' | 'en' | 'vi',
          { singlePlayerKeyboardMode: SINGLE_PLAYER_KEYBOARD_MODE }
        )
      }
      if (officeRef.current && SINGLE_PLAYER_KEYBOARD_MODE) {
        configureSinglePlayerMode(officeRef.current)
      }
      cachedOfficeState = officeRef.current
      officeRef.current?.updateGatewaySreState(gatewaySreRef.current)
      cachedSavedLayout = savedLayoutRef.current
      if (!spriteAssetsPromise) {
        spriteAssetsPromise = Promise.all([loadCharacterPNGs(), loadWallPNG()]).then(() => undefined)
      }
      await spriteAssetsPromise
      setOfficeReady(true)
    }
    loadLayout()

    const savedSound = localStorage.getItem('pixel-office-sound')
    if (savedSound !== null) {
      const enabled = savedSound !== 'false'
      setSoundOn(enabled)
      setSoundEnabled(enabled)
    }

    return () => {
      cachedOfficeState = officeRef.current
      cachedEditorState = editorRef.current
      cachedSavedLayout = savedLayoutRef.current
      cachedPan = panRef.current
      cachedIsEditMode = editorRef.current.isEditMode
      if (animationFrameIdRef.current !== null) {
        cancelAnimationFrame(animationFrameIdRef.current)
      }
    }
  }, [configureSinglePlayerMode, locale])

  useEffect(() => {
    if (SINGLE_PLAYER_KEYBOARD_MODE) return
    const office = officeRef.current
    if (!officeReady || !office || cachedAgents.length === 0) return

    for (const [agentId, charId] of agentIdMapRef.current) {
      office.removeAllSubagentsImmediately(charId)
      office.removeAgentImmediately(charId)
      agentIdMapRef.current.delete(agentId)
    }
    nextIdRef.current.current = 1

    setAgents(cachedAgents)
    syncAgentsToOffice(cachedAgents, office, agentIdMapRef.current, nextIdRef.current)
    cachedAgentIdMap = new Map(agentIdMapRef.current)
    cachedNextCharacterId = nextIdRef.current.current
  }, [officeReady])

  // useEffect(() => {
  //   if (soundOn) {
  //     void playBackgroundMusic()
  //   } else {
  //     stopBackgroundMusic()
  //   }
  // }, [soundOn])


  useEffect(() => {
    cachedAgents = agents
  }, [agents])

  useEffect(() => {
    cachedAgentIdMap = new Map(agentIdMapRef.current)
    cachedNextCharacterId = nextIdRef.current.current
  }, [agents])

  useEffect(() => {
    cachedPrevAgentStates = new Map(prevAgentStatesRef.current)
  }, [agents])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('openclaw-logo-drag-start'))
    return () => {
      window.dispatchEvent(new CustomEvent('openclaw-logo-drag-stop'))
    }
  }, [])

  // Game loop
  useEffect(() => {
    if (!canvasRef.current || !officeRef.current || !containerRef.current) return
    const canvas = canvasRef.current
    const office = officeRef.current
    const container = containerRef.current
    const editor = editorRef.current
    let lastTime = 0

    const render = (time: number) => {
      const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, 0.1)
      lastTime = time

      const width = container.clientWidth
      const height = container.clientHeight

      // Keep desktop zoom fixed. On mobile, fit the whole office into current viewport.
      if (isMobileViewport) {
        const layout = office.layout
        const rows = layout.rows
        const cols = layout.cols
        const baseW = cols * TILE_SIZE
        const topExtraTiles = MOBILE_TOP_EXTRA_TILES
        const fitW = Math.max(1, width - MOBILE_FIT_PADDING_PX * 2) / Math.max(1, baseW)
        const fitH = Math.max(1, height - MOBILE_FIT_PADDING_PX * 2) / Math.max(1, (rows + topExtraTiles) * TILE_SIZE)
        const fitZoom = Math.min(fitW, fitH)
        const nextZoom = Math.max(MOBILE_MIN_ZOOM, Math.min(MOBILE_MAX_ZOOM, fitZoom || MOBILE_CANVAS_ZOOM))
        zoomRef.current = nextZoom

        const mapH = rows * TILE_SIZE * nextZoom
        const centerOffsetY = (height - mapH) / 2
        const topExtraPx = topExtraTiles * TILE_SIZE * nextZoom
        const minPanY = MOBILE_FIT_PADDING_PX + topExtraPx - centerOffsetY
        const maxPanY = height - MOBILE_FIT_PADDING_PX - (centerOffsetY + mapH)
        const basePanY = minPanY > maxPanY ? minPanY : Math.min(maxPanY, Math.max(minPanY, 0))
        const targetPanY = Math.min(maxPanY, Math.max(minPanY - 16, basePanY + MOBILE_VIEW_NUDGE_Y_PX))
        panRef.current = { x: 0, y: Math.round(targetPanY) }
      } else {
        zoomRef.current = DESKTOP_CANVAS_ZOOM
        const layout = office.layout
        const rows = layout.rows
        const mapH = rows * TILE_SIZE * zoomRef.current
        const centerOffsetY = (height - mapH) / 2
        const topExtraPx = DESKTOP_TOP_EXTRA_TILES * TILE_SIZE * zoomRef.current
        const minPanY = topExtraPx + DESKTOP_TOP_SAFE_PADDING_PX - centerOffsetY
        const maxPanY = height - (centerOffsetY + mapH)
        const targetPanY = minPanY > maxPanY
          ? minPanY
          : Math.min(maxPanY, Math.max(minPanY, 0))
        const nextPanY = Math.round(targetPanY)
        if (panRef.current.x !== 0 || panRef.current.y !== nextPanY) {
          panRef.current = { x: 0, y: nextPanY }
        }
      }
      const dpr = window.devicePixelRatio || 1
      office.update(dt)

      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`

      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.imageSmoothingEnabled = false
        ctx.scale(dpr, dpr)

        let editorRender: EditorRenderState | undefined
        if (editor.isEditMode) {
          const sel = editor.selectedFurnitureUid
          const selItem = sel ? office.layout.furniture.find(f => f.uid === sel) : null
          const selEntry = selItem ? getCatalogEntry(selItem.type) : null
          const ghostEntry = (editor.activeTool === EditTool.FURNITURE_PLACE)
            ? getCatalogEntry(editor.selectedFurnitureType) : null
          const showGhostBorder = editor.activeTool === EditTool.TILE_PAINT ||
            editor.activeTool === EditTool.WALL_PAINT || editor.activeTool === EditTool.ERASE

          editorRender = {
            showGrid: true,
            ghostSprite: ghostEntry?.sprite ?? null,
            ghostCol: editor.ghostCol,
            ghostRow: editor.ghostRow,
            ghostValid: editor.ghostValid,
            selectedCol: selItem?.col ?? 0,
            selectedRow: selItem?.row ?? 0,
            selectedW: selEntry?.footprintW ?? 0,
            selectedH: selEntry?.footprintH ?? 0,
            hasSelection: !!selItem,
            isRotatable: selItem ? isRotatable(selItem.type) : false,
            deleteButtonBounds: null,
            rotateButtonBounds: null,
            showGhostBorder,
            ghostBorderHoverCol: editor.ghostCol,
            ghostBorderHoverRow: editor.ghostRow,
          }
        }

        nearExerciseTaskIdRef.current = null
        let nearestInteractableDist = Number.POSITIVE_INFINITY
        const exerciseMarkers: ExerciseMarkerRender[] = []
        const player = office.characters.get(PLAYER_CHARACTER_ID)
        const playerWorldCol = player ? player.x / TILE_SIZE : null
        const playerWorldRow = player ? player.y / TILE_SIZE : null

        for (const task of EXERCISE_TASKS) {
          const bounds = resolveExerciseBounds(task, office.layout.furniture)
          if (!bounds) continue

          const isDone = completedExerciseSet.has(task.id)
          const isNext = !isDone && nextExerciseTaskId === task.id
          const state: ExerciseMarkerRender['state'] = isDone ? 'done' : isNext ? 'next' : 'locked'

          let showArrow = false
          let showInfo = false
          if ((isDone || isNext) && playerWorldCol !== null && playerWorldRow !== null) {
            const targetCol = bounds.col + bounds.w / 2
            const targetRow = bounds.row + bounds.h / 2
            const dist = Math.hypot(playerWorldCol - targetCol, playerWorldRow - targetRow)
            if (dist <= 2.2) {
              if (dist < nearestInteractableDist) {
                nearestInteractableDist = dist
                nearExerciseTaskIdRef.current = task.id
              }
              if (isNext || isDone) {
                showArrow = true
              }
              if (isNext || isDone) {
                showInfo = true
              }
            }
          }

          exerciseMarkers.push({
            id: task.id,
            col: bounds.col,
            row: bounds.row,
            w: bounds.w,
            h: bounds.h,
            state,
            showArrow,
            showInfo,
            title: `Bài ${task.id}: ${task.title}`,
            content: task.content,
          })
        }

        const exerciseOverlay: ExerciseOverlayRender = { markers: exerciseMarkers }

        renderFrame(ctx, width, height, office.tileMap, office.furniture, office.getCharacters(),
          zoomRef.current, panRef.current.x, panRef.current.y,
          { selectedAgentId: null, hoveredAgentId, hoveredTile: null, seats: office.seats, characters: office.characters },
          editorRender, office.layout.tileColors, office.layout.cols, office.layout.rows,
          undefined,
          contributionsRef.current ?? undefined, photographRef.current ?? undefined, wallCameraRef.current ?? undefined, deskCameraRef.current ?? undefined,
          leftRouterRef.current ?? undefined, rightRouterRef.current ?? undefined,
          gatewayHealthyRef.current,
          exerciseOverlay,
          exerciseArrowRef.current ?? undefined)

        // Collect photo comment positions for DOM rendering
        const zoom = zoomRef.current
        const pan = panRef.current
        const cols = office.layout.cols
        const rows = office.layout.rows
        const mapW = cols * TILE_SIZE * zoom
        const mapH = rows * TILE_SIZE * zoom
        const ox = (width - mapW) / 2 + pan.x
        const oy = (height - mapH) / 2 + pan.y
        const containerTop = container.offsetTop
        const lifetime = 4.0
        const items: Array<{ key: string; text: string; x: number; y: number; opacity: number }> = []
        const codeItems: Array<{ key: string; text: string; x: number; y: number; opacity: number; kind?: 'default' | 'sre' }> = []
        const workingCharIds = new Set<number>()
        for (const a of agents) {
          if (a.state !== 'working') continue
          const cid = agentIdMapRef.current.get(a.agentId)
          if (typeof cid === 'number') workingCharIds.add(cid)
        }
        for (const ch of office.getCharacters()) {
          if (ch.photoComments.length === 0) continue
          const anchorX = ox + ch.x * zoom
          const anchorY = containerTop + oy + (ch.y - 24) * zoom
          const totalDist = anchorY + 20
          for (let i = 0; i < ch.photoComments.length; i++) {
            const pc = ch.photoComments[i]
            const progress = pc.age / lifetime
            let alpha = 1.0
            if (pc.age < 0.3) alpha = pc.age / 0.3
            if (progress > 0.6) alpha = (1 - progress) / 0.4
            const floatY = progress * totalDist
            items.push({
              key: `${ch.id}-${i}-${pc.text}`,
              text: pc.text,
              x: anchorX + pc.x * zoom,
              y: anchorY - floatY,
              opacity: Math.max(0, alpha * 0.95),
            })
          }
        }
        for (const ch of office.getCharacters()) {
          const isSreBlackword =
            ch.systemRoleType === 'gateway_sre' &&
            ch.systemStatus === 'down' &&
            ch.state === 'idle'
          const hasInjectedSnippet = ch.codeSnippets.length > 0
          if (!workingCharIds.has(ch.id) && !isSreBlackword && !hasInjectedSnippet) continue
          if (ch.codeSnippets.length === 0) continue
          const anchorX = ox + ch.x * zoom
          const anchorY = containerTop + oy + (ch.y - (isSreBlackword ? 24 : 10)) * zoom
          const totalDist = isSreBlackword
            ? Math.min(anchorY + 24, SRE_BLACKWORD_MAX_FLOAT_DIST_PX)
            : (anchorY + 24)
          for (let i = 0; i < ch.codeSnippets.length; i++) {
            const s = ch.codeSnippets[i]
            const progress = s.age / CODE_SNIPPET_LIFETIME_SEC
            if (progress <= 0 || progress >= 1) continue
            const alpha = progress < 0.15 ? progress / 0.15 : progress > 0.88 ? (1 - progress) / 0.12 : 1
            codeItems.push({
              key: `${ch.id}-code-${i}-${s.text}`,
              text: s.text,
              x: anchorX + s.x * zoom,
              y: anchorY - progress * totalDist,
              opacity: Math.max(0, alpha * 0.9),
              kind: isSreBlackword ? 'sre' : 'default',
            })
          }
        }
        floatingCommentsRef.current = items
        floatingCodeRef.current = codeItems
        const hasFloating = items.length > 0 || codeItems.length > 0
        const now = performance.now()
        const tickInterval = hasFloating
          ? (isMobileViewport ? FLOATING_TICK_INTERVAL_MOBILE_MS : FLOATING_TICK_INTERVAL_DESKTOP_MS)
          : 180
        if (now - floatingTickUpdatedAtRef.current >= tickInterval) {
          floatingTickUpdatedAtRef.current = now
          setFloatingTick(t => t + 1)
        }
      }
      animationFrameIdRef.current = requestAnimationFrame(render)
    }
    animationFrameIdRef.current = requestAnimationFrame(render)
    return () => {
      if (animationFrameIdRef.current !== null) cancelAnimationFrame(animationFrameIdRef.current)
    }
  }, [hoveredAgentId, editorTick, officeReady, agents, isMobileViewport, completedExerciseSet, nextExerciseTaskId])

  // Load GitHub contribution heatmap data (real → fallback mock)
  useEffect(() => {
    // 先设置 mock 保证立即有内容
    const mockWeeks = Array.from({ length: 52 }, () => ({
      days: Array.from({ length: 7 }, () => ({
        count: Math.random() < 0.25 ? 0 : Math.floor(Math.random() * 12),
        date: '',
      })),
    }))
    contributionsRef.current = { weeks: mockWeeks, username: 'mock' }

    // 异步拉取真实数据
    fetch('/api/pixel-office/contributions')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.weeks) {
          contributionsRef.current = data
        }
      })
      .catch(() => {})
  }, [])

  // Load photograph for right room wall
  useEffect(() => {
    const img = new Image()
    img.src = '/assets/pixel-office/photograph.webp'
    img.onload = () => { photographRef.current = img }
  }, [])

  // Load desk camera asset for camera furniture rendering
  useEffect(() => {
    const img = new Image()
    img.src = '/assets/pixel-office/camera3.jpg'
    img.onload = () => { deskCameraRef.current = img }
  }, [])

  // Load top-left wall camera image
  useEffect(() => {
    const img = new Image()
    img.src = '/assets/pixel-office/camerathewall.png'
    img.onload = () => { wallCameraRef.current = img }
  }, [])

  // Load exercise arrow asset for marker guidance
  useEffect(() => {
    const img = new Image()
    img.src = '/assets/pixel-office/arrow.png'
    img.onload = () => { exerciseArrowRef.current = img }
  }, [])

  // Load router images for replacing two left-room laptops
  useEffect(() => {
    const loadRouterWithTransparentWhite = (src: string, assign: (img: HTMLImageElement) => void) => {
      const raw = new Image()
      raw.src = src
      raw.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = raw.naturalWidth
        canvas.height = raw.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          assign(raw)
          return
        }

        ctx.drawImage(raw, 0, 0)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const data = imageData.data
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          if (r > 245 && g > 245 && b > 245) {
            data[i + 3] = 0
          }
        }
        ctx.putImageData(imageData, 0, 0)

        const cleaned = new Image()
        cleaned.src = canvas.toDataURL('image/png')
        cleaned.onload = () => assign(cleaned)
      }
    }

    loadRouterWithTransparentWhite('/assets/pixel-office/router2.jpg', (img) => {
      leftRouterRef.current = img
    })
    loadRouterWithTransparentWhite('/assets/pixel-office/router.jpg', (img) => {
      rightRouterRef.current = img
    })
  }, [])

  // Preload activity heatmap data
  useEffect(() => {
    fetch('/api/activity-heatmap')
      .then(r => r.json())
      .then(data => { if (data.agents) activityHeatmapRef.current = data.agents })
      .catch(() => {})
  }, [])

  // Preload version info
  useEffect(() => {
    void fetchVersionInfo()
  }, [fetchVersionInfo])

  // Preload idle rank data
  useEffect(() => {
    fetch('/api/pixel-office/idle-rank')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data && data.agents) idleRankRef.current = data.agents })
      .catch(() => {})
  }, [])

  // Poll for agent activity + sound notification
  useEffect(() => {
    if (SINGLE_PLAYER_KEYBOARD_MODE) return
    if (cachedAgents.length > 0) {
      setAgents(cachedAgents)
      if (officeRef.current && officeReadyRef.current) {
        syncAgentsToOffice(cachedAgents, officeRef.current, agentIdMapRef.current, nextIdRef.current)
      }
    }
    const fetchAgents = async () => {
      try {
        const res = await fetch('/api/agent-activity', { cache: 'no-store' })
        const data = await res.json()
        const newAgents: AgentActivity[] = data.agents || []
        setAgents(newAgents)
        cachedAgents = newAgents

        const office = officeRef.current
        if (office && officeReadyRef.current) {
          syncAgentsToOffice(newAgents, office, agentIdMapRef.current, nextIdRef.current)
          cachedAgentIdMap = new Map(agentIdMapRef.current)
          cachedNextCharacterId = nextIdRef.current.current

          const seen = seenSubagentEventKeysRef.current
          const now = Date.now()
          for (const [key, ts] of seen.entries()) {
            if (now - ts > 24 * 60 * 60 * 1000) seen.delete(key)
          }
          for (const agent of newAgents) {
            const parentCharId = agentIdMapRef.current.get(agent.agentId)
            if (typeof parentCharId !== 'number') continue
            if (!agent.subagents?.length) continue
            for (const sub of agent.subagents) {
              if (!sub.activityEvents?.length) continue
              const subKey = sub.sessionKey ? `${sub.sessionKey}::${sub.toolId}` : sub.toolId
              const subCharId = office.getSubagentId(parentCharId, subKey)
              if (subCharId == null) continue

              const orderedEvents = (sub.activityEvents || []).slice().sort((a, b) => a.at - b.at)
              let emittedNew = false
              for (const event of orderedEvents) {
                const uniq = `${agent.agentId}:${subKey}:${event.key}`
                if (seen.has(uniq)) continue
                seen.set(uniq, now)
                office.pushCodeSnippet(subCharId, event.text)
                emittedNew = true
              }

              // Fallback: if no parsed activity events yet, show subagent task label once.
              if (!emittedNew && orderedEvents.length === 0 && sub.label) {
                const fallbackUniq = `${agent.agentId}:${subKey}:label`
                if (!seen.has(fallbackUniq)) {
                  seen.set(fallbackUniq, now)
                  office.pushCodeSnippet(subCharId, `task: ${sub.label}`)
                }
              }
            }
          }
        }

        // Play sound when agent transitions to waiting
        for (const agent of newAgents) {
          const prev = prevAgentStatesRef.current.get(agent.agentId)
          if (agent.state === 'waiting' && prev && prev !== 'waiting') {
            playDoneSound()
          }
          // Broadcast notification on meaningful state transitions
          if (prev && prev !== agent.state) {
            if (agent.state === 'working' && prev !== 'working') {
              const bid = Date.now() + Math.random()
              setBroadcasts(b => [...b, { id: bid, emoji: agent.emoji, text: `${agent.emoji} ${agent.name} ${t('pixelOffice.broadcast.online')}` }])
              setTimeout(() => setBroadcasts(b => b.filter(x => x.id !== bid)), 5000)
            } else if (agent.state === 'offline' && prev === 'working') {
              const bid = Date.now() + Math.random()
              setBroadcasts(b => [...b, { id: bid, emoji: agent.emoji, text: `${agent.emoji} ${agent.name} ${t('pixelOffice.broadcast.offline')}` }])
              setTimeout(() => setBroadcasts(b => b.filter(x => x.id !== bid)), 5000)
            }
          }
        }
        const stateMap = new Map<string, string>()
        for (const a of newAgents) stateMap.set(a.agentId, a.state)
        prevAgentStatesRef.current = stateMap
        cachedPrevAgentStates = new Map(stateMap)
      } catch (e) {
        console.error('Failed to fetch agents:', e)
      }
    }
    fetchAgents()
    const interval = setInterval(fetchAgents, AGENT_ACTIVITY_POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  // Poll agent session stats from /api/config
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/config')
        const data = await res.json()
        const map = new Map<string, { sessionCount: number; messageCount: number; totalTokens: number; todayAvgResponseMs: number; weeklyResponseMs: number[]; weeklyTokens: number[]; lastActive: number | null }>()
        const configMap = new Map<string, ConfigAgentCard>()
        for (const agent of (data.agents || [])) {
          configMap.set(agent.id, {
            id: agent.id,
            name: agent.name || agent.id,
            emoji: agent.emoji || '🤖',
            model: agent.model || '',
            platforms: Array.isArray(agent.platforms) ? agent.platforms : [],
            session: agent.session || undefined,
          })
          if (agent.session) {
            map.set(agent.id, {
              sessionCount: agent.session.sessionCount || 0,
              messageCount: agent.session.messageCount || 0,
              totalTokens: agent.session.totalTokens || 0,
              todayAvgResponseMs: agent.session.todayAvgResponseMs || 0,
              weeklyResponseMs: agent.session.weeklyResponseMs || [],
              weeklyTokens: agent.session.weeklyTokens || [],
              lastActive: agent.session.lastActive || null,
            })
          }
        }
        agentStatsRef.current = map
        configAgentsRef.current = configMap
        if (data.gateway) gatewayRef.current = { port: data.gateway.port || 18789, token: data.gateway.token, host: data.gateway.host }
        if (data.providers) {
          providersRef.current = data.providers
          const accessModeMap: Record<string, 'auth' | 'api_key'> = {}
          for (const provider of data.providers) {
            if (provider?.id && (provider.accessMode === 'auth' || provider.accessMode === 'api_key')) {
              accessModeMap[provider.id] = provider.accessMode
            }
          }
          providerAccessModeRef.current = accessModeMap
        }
      } catch {}
    }
    fetchStats()
    const interval = setInterval(fetchStats, 30000)
    return () => clearInterval(interval)
  }, [])

  // Poll gateway health for server alarm lamp in Pixel Office
  useEffect(() => {
    void refreshGatewayHealthSnapshot()
    const interval = setInterval(refreshGatewayHealthSnapshot, GATEWAY_HEALTH_POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [refreshGatewayHealthSnapshot])

  useEffect(() => {
    if (!selectedAgentId) return
    try {
      const modelRaw = localStorage.getItem('agentTestResults')
      setCachedModelTestResults(modelRaw ? JSON.parse(modelRaw) : null)
    } catch {
      setCachedModelTestResults(null)
    }
    try {
      const platformRaw = localStorage.getItem('platformTestResults')
      setCachedPlatformTestResults(platformRaw ? JSON.parse(platformRaw) : null)
    } catch {
      setCachedPlatformTestResults(null)
    }
    try {
      const sessionRaw = localStorage.getItem('sessionTestResults')
      setCachedSessionTestResults(sessionRaw ? JSON.parse(sessionRaw) : null)
    } catch {
      setCachedSessionTestResults(null)
    }
    try {
      const dmRaw = localStorage.getItem('dmSessionResults')
      setCachedDmSessionResults(dmRaw ? JSON.parse(dmRaw) : null)
    } catch {
      setCachedDmSessionResults(null)
    }
  }, [selectedAgentId])

  // Keep gateway SRE head label aligned with current locale.
  useEffect(() => {
    if (!officeReady) return
    const office = officeRef.current
    if (!office) return
    const info = office.getGatewaySreInfo()
    if (!info) return
    const ch = office.characters.get(info.id)
    if (ch) ch.label = t('pixelOffice.gatewaySre.name')
  }, [officeReady, t])

  // ── Editor helpers ──────────────────────────────────────────
  const applyEdit = useCallback((newLayout: OfficeLayout) => {
    const office = officeRef.current
    const editor = editorRef.current
    if (!office) return
    if (newLayout === office.layout) return
    editor.pushUndo(office.layout)
    editor.clearRedo()
    editor.isDirty = true
    office.rebuildFromLayout(newLayout)
    forceEditorUpdate()
  }, [forceEditorUpdate])

  const handleUndo = useCallback(() => {
    const office = officeRef.current
    const editor = editorRef.current
    if (!office) return
    const prev = editor.popUndo()
    if (!prev) return
    editor.pushRedo(office.layout)
    office.rebuildFromLayout(prev)
    editor.isDirty = true
    editor.clearSelection()
    forceEditorUpdate()
  }, [forceEditorUpdate])

  const handleRedo = useCallback(() => {
    const office = officeRef.current
    const editor = editorRef.current
    if (!office) return
    const next = editor.popRedo()
    if (!next) return
    editor.pushUndo(office.layout)
    office.rebuildFromLayout(next)
    editor.isDirty = true
    editor.clearSelection()
    forceEditorUpdate()
  }, [forceEditorUpdate])

  const handleSave = useCallback(async () => {
    const office = officeRef.current
    const editor = editorRef.current
    if (!office) return
    try {
      await fetch('/api/pixel-office/layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: office.layout }),
      })
      savedLayoutRef.current = office.layout
      editor.isDirty = false
      forceEditorUpdate()
    } catch (e) {
      console.error('Failed to save layout:', e)
    }
  }, [forceEditorUpdate])

  const handleReset = useCallback(() => {
    const office = officeRef.current
    const editor = editorRef.current
    if (!office) return
    const defaultLayout = savedLayoutRef.current || createDefaultLayout()
    editor.pushUndo(office.layout)
    editor.clearRedo()
    office.rebuildFromLayout(defaultLayout)
    editor.isDirty = false
    editor.clearSelection()
    forceEditorUpdate()
  }, [forceEditorUpdate])

  // ── Mouse events ──────────────────────────────────────────
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!canvasRef.current || !officeRef.current) return
    const office = officeRef.current
    const editor = editorRef.current
    const rect = canvasRef.current.getBoundingClientRect()
    mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const { col, row, worldX, worldY } = mouseToTile(e.clientX, e.clientY, canvasRef.current, office, zoomRef.current, panRef.current)

    if (editor.isEditMode) {
      if (serverTooltip.open) setServerTooltip((prev) => ({ ...prev, open: false }))
      // Update ghost preview
      if (editor.activeTool === EditTool.FURNITURE_PLACE) {
        const entry = getCatalogEntry(editor.selectedFurnitureType)
        if (entry) {
          const placementRow = entry.canPlaceOnWalls ? getWallPlacementRow(editor.selectedFurnitureType, row) : row
          editor.ghostCol = col
          editor.ghostRow = placementRow
          editor.ghostValid = canPlaceFurniture(office.layout, editor.selectedFurnitureType, col, placementRow)
        }
      } else if (editor.activeTool === EditTool.TILE_PAINT || editor.activeTool === EditTool.WALL_PAINT || editor.activeTool === EditTool.ERASE) {
        editor.ghostCol = col
        editor.ghostRow = row
        // Drag painting
        if (editor.isDragging && col >= 0 && col < office.layout.cols && row >= 0 && row < office.layout.rows) {
          if (editor.activeTool === EditTool.TILE_PAINT) {
            applyEdit(paintTile(office.layout, col, row, editor.selectedTileType, editor.floorColor))
          } else if (editor.activeTool === EditTool.WALL_PAINT) {
            const currentTile = office.layout.tiles[row * office.layout.cols + col]
            if (editor.wallDragAdding === null) {
              editor.wallDragAdding = currentTile !== TileType.WALL
            }
            if (editor.wallDragAdding && currentTile !== TileType.WALL) {
              applyEdit(paintTile(office.layout, col, row, TileType.WALL, editor.wallColor))
            } else if (!editor.wallDragAdding && currentTile === TileType.WALL) {
              applyEdit(paintTile(office.layout, col, row, TileType.FLOOR_1, editor.floorColor))
            }
          } else if (editor.activeTool === EditTool.ERASE) {
            applyEdit(paintTile(office.layout, col, row, TileType.VOID as TileTypeVal))
          }
        }
      } else {
        editor.ghostCol = col
        editor.ghostRow = row
      }

      // Drag-to-move furniture
      if (editor.dragUid) {
        const dx = col - editor.dragStartCol
        const dy = row - editor.dragStartRow
        if (!editor.isDragMoving && (Math.abs(dx) > 0 || Math.abs(dy) > 0)) {
          editor.isDragMoving = true
        }
        if (editor.isDragMoving) {
          const newCol = col - editor.dragOffsetCol
          const newRow = row - editor.dragOffsetRow
          const newLayout = moveFurniture(office.layout, editor.dragUid, newCol, newRow)
          if (newLayout !== office.layout) {
            office.rebuildFromLayout(newLayout)
            editor.isDirty = true
          }
        }
      }
    } else {
      // Normal mode: hover detection
      const id = office.getCharacterAt(worldX, worldY)
      const lobsterId = office.getFirstLobsterAt(worldX, worldY)
      setHoveredAgentId(id)
      // Pointer cursor on camera furniture
      const tileX = worldX / TILE_SIZE
      const tileY = worldY / TILE_SIZE
      const onCamera = office.layout.furniture.some(f => {
        if (f.type !== 'camera') return false
        const entry = getCatalogEntry(f.type)
        if (!entry) return false
        return tileX >= f.col && tileX < f.col + entry.footprintW &&
               tileY >= f.row && tileY < f.row + entry.footprintH
      })
      const onPC = office.layout.furniture.some(f => {
        if (f.type !== 'pc') return false
        const entry = getCatalogEntry(f.type)
        if (!entry) return false
        return tileX >= f.col && tileX < f.col + entry.footprintW &&
               tileY >= f.row && tileY < f.row + entry.footprintH
      })
      const onLibrary = office.layout.furniture.some(f => {
        if (f.uid !== 'library-r') return false
        const entry = getCatalogEntry(f.type)
        if (!entry) return false
        return tileX >= f.col && tileX < f.col + entry.footprintW &&
               tileY >= f.row && tileY < f.row + entry.footprintH
      })
      const onWhiteboard = office.layout.furniture.some(f => {
        if (f.uid !== 'whiteboard-r') return false
        const entry = getCatalogEntry(f.type)
        if (!entry) return false
        return tileX >= f.col && tileX < f.col + entry.footprintW &&
               tileY >= f.row && tileY < f.row + entry.footprintH
      })
      const onClock = office.layout.furniture.some(f => {
        if (f.uid !== 'clock-r') return false
        const entry = getCatalogEntry(f.type)
        if (!entry) return false
        return tileX >= f.col && tileX < f.col + entry.footprintW &&
               tileY >= f.row && tileY < f.row + entry.footprintH
      })
      const onPhone = office.layout.furniture.some(f => {
        if (f.type !== 'phone') return false
        const entry = getCatalogEntry(f.type)
        if (!entry) return false
        return tileX >= f.col && tileX < f.col + entry.footprintW &&
               tileY >= f.row && tileY < f.row + entry.footprintH
      })
      const onSofa = office.layout.furniture.some(f => {
        if (f.type !== 'sofa') return false
        const entry = getCatalogEntry(f.type)
        if (!entry) return false
        return tileX >= f.col && tileX < f.col + entry.footprintW &&
               tileY >= f.row && tileY < f.row + entry.footprintH
      })
      const onServer = office.layout.furniture.some(f => {
        if (f.uid !== 'server-b-left' && f.type !== 'server_rack') return false
        const entry = getCatalogEntry(f.type)
        if (!entry) return false
        return tileX >= f.col && tileX < f.col + entry.footprintW &&
               tileY >= f.row && tileY < f.row + entry.footprintH
      })
      const onPhoto = photographRef.current && tileX >= 10 && tileX < 17 && tileY >= -0.5 && tileY < 1
      const onHeatmap = contributionsRef.current && contributionsRef.current.username !== 'mock' && tileX >= 1 && tileX < 10 && tileY >= -0.5 && tileY < 1
      if (canvasRef.current) canvasRef.current.style.cursor = (onCamera || onPC || onLibrary || onWhiteboard || onClock || onPhone || onSofa || onServer || id !== null || lobsterId !== null || onPhoto || onHeatmap) ? 'pointer' : 'default'
    }
  }

  const PHOTO_COUNT = 13
  const handleMouseDown = (e: React.MouseEvent) => {
    unlockAudio()
    if (!canvasRef.current || !officeRef.current) return
    const office = officeRef.current
    const editor = editorRef.current
    if (!editor.isEditMode) {
      // Non-edit mode: check camera click or character click
      if (e.button === 0) {
        setSubagentCreatorInfo(null)
        const rect = canvasRef.current.getBoundingClientRect()
        const clickX = e.clientX - rect.left
        const clickY = e.clientY - rect.top
        const { worldX, worldY } = mouseToTile(e.clientX, e.clientY, canvasRef.current, office, zoomRef.current, panRef.current)
        const tileX = worldX / TILE_SIZE
        const tileY = worldY / TILE_SIZE
        const clickedServer = office.layout.furniture.some(f => {
          if (f.uid !== 'server-b-left' && f.type !== 'server_rack') return false
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return tileX >= f.col && tileX < f.col + entry.footprintW &&
                 tileY >= f.row && tileY < f.row + entry.footprintH
        })
        if (!clickedServer && serverTooltip.open) {
          setServerTooltip((prev) => ({ ...prev, open: false }))
        }
        const clickedCamera = office.layout.furniture.find(f => {
          if (f.type !== 'camera') return false
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return tileX >= f.col && tileX < f.col + entry.footprintW &&
                 tileY >= f.row && tileY < f.row + entry.footprintH
        })
        if (clickedCamera) {
          const idx = Math.floor(Math.random() * PHOTO_COUNT) + 1
          const img = new Image()
          img.src = `/assets/pixel-office/my-photographic-works/${idx}.webp`
          img.onload = () => { photographRef.current = img }
        } else if (office.layout.furniture.some(f => {
          if (f.type !== 'pc') return false
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return tileX >= f.col && tileX < f.col + entry.footprintW &&
                 tileY >= f.row && tileY < f.row + entry.footprintH
        })) {
          // Click on PC — open gateway chat for main agent
          const gw = gatewayRef.current
          const sessionKey = 'agent:main:main'
          let chatUrl = buildGatewayUrl(gw.port, '/chat', { session: sessionKey }, gw.host)
          if (gw.token) chatUrl = buildGatewayUrl(gw.port, '/chat', { session: sessionKey, token: gw.token }, gw.host)
          window.open(chatUrl, '_blank')
        } else if (office.layout.furniture.some(f => {
          if (f.uid !== 'library-r') return false
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return tileX >= f.col && tileX < f.col + entry.footprintW &&
                 tileY >= f.row && tileY < f.row + entry.footprintH
        })) {
          // Click on right bookshelf — show model panel
          modelPanelOpenedAtRef.current = performance.now()
          setShowModelPanel(true)
        } else if (office.layout.furniture.some(f => {
          if (f.uid !== 'whiteboard-r') return false
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return tileX >= f.col && tileX < f.col + entry.footprintW &&
                 tileY >= f.row && tileY < f.row + entry.footprintH
        })) {
          // Click on right whiteboard — show token ranking
          tokenRankOpenedAtRef.current = performance.now()
          setShowTokenRank(true)
        } else if (office.layout.furniture.some(f => {
          if (f.uid !== 'clock-r') return false
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return tileX >= f.col && tileX < f.col + entry.footprintW &&
                 tileY >= f.row && tileY < f.row + entry.footprintH
        })) {
          // Click on clock — show activity heatmap
          setShowActivityHeatmap(true)
          if (!activityHeatmapRef.current) {
            fetch('/api/activity-heatmap')
              .then(r => r.json())
              .then(data => { if (data.agents) activityHeatmapRef.current = data.agents })
              .catch(() => {})
          }
        } else if (office.layout.furniture.some(f => {
          if (f.type !== 'phone') return false
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return tileX >= f.col && tileX < f.col + entry.footprintW &&
                 tileY >= f.row && tileY < f.row + entry.footprintH
        })) {
          // Click on phone — show version info
          setShowPhonePanel(true)
          void fetchVersionInfo(true)
        } else if (office.layout.furniture.some(f => {
          if (f.type !== 'sofa') return false
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return tileX >= f.col && tileX < f.col + entry.footprintW &&
                 tileY >= f.row && tileY < f.row + entry.footprintH
        })) {
          // Click on sofa — show idle rank
          setShowIdleRank(true)
        } else if (clickedServer) {
          // Click on server rack — show tooltip and refresh latest status
          setServerTooltip({ open: true, x: clickX, y: clickY })
          void refreshGatewayHealthSnapshot()
        } else if (photographRef.current && tileX >= 10 && tileX < 17 && tileY >= -0.5 && tileY < 1) {
          // Click on wall photograph — fullscreen view
          fullscreenPhotoOpenedAtRef.current = performance.now()
          setFullscreenPhoto(true)
        } else if (contributionsRef.current && contributionsRef.current.username !== 'mock' && tileX >= 1 && tileX < 10 && tileY >= -0.5 && tileY < 1) {
          // Click on GitHub contribution heatmap — open profile
          window.open(`https://github.com/${contributionsRef.current.username}`, '_blank')
        } else if (office.getFirstLobsterAt(worldX, worldY) !== null) {
          // Click on first lobster — toggle rage mode
          office.toggleFirstLobsterRage()
        } else {
          // Check character click
          const charId = office.getCharacterAt(worldX, worldY)
          if (charId !== null) {
            const map = agentIdMapRef.current
            let found = false
            for (const [aid, cid] of map.entries()) {
              if (cid === charId) {
                selectedAgentOpenedAtRef.current = performance.now()
                setSelectedAgentId(aid)
                found = true
                break
              }
            }
            if (!found) {
              const clickedCh = office.characters.get(charId)
              if (clickedCh?.systemRoleType === 'gateway_sre' && isMobileViewport) {
                setServerTooltip({ open: true, x: clickX, y: clickY })
                void refreshGatewayHealthSnapshot()
              } else if (clickedCh?.isSubagent && clickedCh.parentAgentId != null) {
                let parentAgentId: string | null = null
                for (const [aid, cid] of map.entries()) {
                  if (cid === clickedCh.parentAgentId) {
                    parentAgentId = aid
                    break
                  }
                }
                if (parentAgentId && isMobileViewport) {
                  setSubagentCreatorInfo({
                    parentAgentId,
                    x: clickX,
                    y: clickY,
                  })
                }
              }
              setSelectedAgentId(null)
            }
          } else {
            setSelectedAgentId(null)
          }
        }
      }
      return
    }
    const { col, row } = mouseToTile(e.clientX, e.clientY, canvasRef.current, office, zoomRef.current, panRef.current)

    if (e.button === 0) {
      // Left click
      const tool = editor.activeTool
      if (tool === EditTool.TILE_PAINT || tool === EditTool.WALL_PAINT || tool === EditTool.ERASE) {
        editor.isDragging = true
        editor.wallDragAdding = null

        // Check ghost border expansion
        const dir = getGhostBorderDirection(col, row, office.layout.cols, office.layout.rows)
        if (dir) {
          const result = expandLayout(office.layout, dir)
          if (result) {
            applyEdit(result.layout)
            office.rebuildFromLayout(result.layout, result.shift)
          }
          return
        }

        if (col >= 0 && col < office.layout.cols && row >= 0 && row < office.layout.rows) {
          if (tool === EditTool.TILE_PAINT) {
            applyEdit(paintTile(office.layout, col, row, editor.selectedTileType, editor.floorColor))
          } else if (tool === EditTool.WALL_PAINT) {
            const currentTile = office.layout.tiles[row * office.layout.cols + col]
            editor.wallDragAdding = currentTile !== TileType.WALL
            if (editor.wallDragAdding) {
              applyEdit(paintTile(office.layout, col, row, TileType.WALL, editor.wallColor))
            } else {
              applyEdit(paintTile(office.layout, col, row, TileType.FLOOR_1, editor.floorColor))
            }
          } else if (tool === EditTool.ERASE) {
            applyEdit(paintTile(office.layout, col, row, TileType.VOID as TileTypeVal))
          }
        }
      } else if (tool === EditTool.FURNITURE_PLACE) {
        if (editor.ghostValid && col >= 0) {
          const entry = getCatalogEntry(editor.selectedFurnitureType)
          if (entry) {
            const placementRow = entry.canPlaceOnWalls ? getWallPlacementRow(editor.selectedFurnitureType, row) : row
            const uid = `furn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
            const item = {
              uid, type: editor.selectedFurnitureType, col, row: placementRow,
              ...(editor.pickedFurnitureColor ? { color: editor.pickedFurnitureColor } : {}),
            }
            applyEdit(placeFurniture(office.layout, item))
          }
        }
      } else if (tool === EditTool.SELECT) {
        // Check if clicking on placed furniture
        const clickedItem = office.layout.furniture.find(f => {
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return col >= f.col && col < f.col + entry.footprintW && row >= f.row && row < f.row + entry.footprintH
        })
        if (clickedItem) {
          editor.selectedFurnitureUid = clickedItem.uid
          editor.startDrag(clickedItem.uid, col, row, col - clickedItem.col, row - clickedItem.row)
        } else {
          editor.clearSelection()
        }
        forceEditorUpdate()
      } else if (tool === EditTool.EYEDROPPER) {
        if (col >= 0 && col < office.layout.cols && row >= 0 && row < office.layout.rows) {
          const idx = row * office.layout.cols + col
          const tile = office.layout.tiles[idx]
          if (tile !== TileType.WALL && tile !== TileType.VOID) {
            editor.selectedTileType = tile
            const color = office.layout.tileColors?.[idx]
            if (color) editor.floorColor = { ...color }
          } else if (tile === TileType.WALL) {
            const color = office.layout.tileColors?.[idx]
            if (color) editor.wallColor = { ...color }
            editor.activeTool = EditTool.WALL_PAINT
          }
          editor.activeTool = editor.activeTool === EditTool.EYEDROPPER ? EditTool.TILE_PAINT : editor.activeTool
          forceEditorUpdate()
        }
      } else if (tool === EditTool.FURNITURE_PICK) {
        const pickedItem = office.layout.furniture.find(f => {
          const entry = getCatalogEntry(f.type)
          if (!entry) return false
          return col >= f.col && col < f.col + entry.footprintW && row >= f.row && row < f.row + entry.footprintH
        })
        if (pickedItem) {
          editor.selectedFurnitureType = pickedItem.type
          editor.pickedFurnitureColor = pickedItem.color ? { ...pickedItem.color } : null
          editor.activeTool = EditTool.FURNITURE_PLACE
          forceEditorUpdate()
        }
      }
    }
  }

  const handleMouseUp = () => {
    const editor = editorRef.current
    if (editor.isDragging) {
      editor.isDragging = false
      editor.wallDragAdding = null
    }
    if (editor.dragUid) {
      if (editor.isDragMoving) {
        // Commit the drag move to undo stack
        editor.isDirty = true
        forceEditorUpdate()
      }
      editor.clearDrag()
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    const editor = editorRef.current
    if (!editor.isEditMode) return
    e.preventDefault()
    if (!canvasRef.current || !officeRef.current) return
    const office = officeRef.current
    const { col, row } = mouseToTile(e.clientX, e.clientY, canvasRef.current, office, zoomRef.current, panRef.current)
    if (col >= 0 && col < office.layout.cols && row >= 0 && row < office.layout.rows) {
      applyEdit(paintTile(office.layout, col, row, TileType.VOID as TileTypeVal))
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse') return
    e.preventDefault()
    handleMouseMove({ clientX: e.clientX, clientY: e.clientY, button: 0 } as React.MouseEvent)
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse') return
    e.preventDefault()
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId)
    handleMouseDown({ clientX: e.clientX, clientY: e.clientY, button: 0 } as React.MouseEvent)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse') return
    e.preventDefault()
    handleMouseUp()
  }

  // ── Keyboard events ──────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const editor = editorRef.current
      const office = officeRef.current
      if (!editor.isEditMode || !office) return

      if (e.key === 'r' || e.key === 'R') {
        if (editor.selectedFurnitureUid) {
          applyEdit(rotateFurniture(office.layout, editor.selectedFurnitureUid, e.shiftKey ? 'ccw' : 'cw'))
        }
      } else if (e.key === 't' || e.key === 'T') {
        if (editor.selectedFurnitureUid) {
          applyEdit(toggleFurnitureState(office.layout, editor.selectedFurnitureUid))
        }
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      } else if ((e.key === 'y' && (e.ctrlKey || e.metaKey)) || (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
        e.preventDefault()
        handleRedo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (editor.selectedFurnitureUid) {
          applyEdit(removeFurniture(office.layout, editor.selectedFurnitureUid))
          editor.clearSelection()
          forceEditorUpdate()
        }
      } else if (e.key === 'Escape') {
        // Multi-stage escape
        if (editor.activeTool === EditTool.FURNITURE_PICK) {
          editor.activeTool = EditTool.FURNITURE_PLACE
        } else if (editor.selectedFurnitureUid) {
          editor.clearSelection()
        } else if (editor.activeTool !== EditTool.SELECT) {
          editor.activeTool = EditTool.SELECT
        } else {
          editor.isEditMode = false
          setIsEditMode(false)
        }
        forceEditorUpdate()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [applyEdit, handleUndo, handleRedo, forceEditorUpdate])

  // Esc closes modal overlays in non-edit mode for keyboard accessibility.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isEditMode) return
      if (exerciseScene !== null) {
        closeExerciseScene()
        return
      }
      if (fullscreenPhoto) {
        setFullscreenPhoto(false)
        return
      }
      if (showIdleRank) {
        setShowIdleRank(false)
        return
      }
      if (showPhonePanel) {
        setShowPhonePanel(false)
        return
      }
      if (showActivityHeatmap) {
        setShowActivityHeatmap(false)
        return
      }
      if (showTokenRank) {
        setShowTokenRank(false)
        return
      }
      if (showModelPanel) {
        setShowModelPanel(false)
        return
      }
      if (subagentCreatorInfo) {
        setSubagentCreatorInfo(null)
        return
      }
      if (selectedAgentId) {
        setSelectedAgentId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeExerciseScene, exerciseScene, fullscreenPhoto, isEditMode, selectedAgentId, showActivityHeatmap, showIdleRank, showModelPanel, showPhonePanel, showTokenRank, subagentCreatorInfo])

  useEffect(() => {
    if (!SINGLE_PLAYER_KEYBOARD_MODE) return

    const pressedKeys = new Set<string>()
    const keyOrder: string[] = []
    let rafId: number | null = null

    const isTextInputTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      if (!el) return false
      return (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      )
    }

    const getMoveDelta = (key: string): { dc: number; dr: number } | null => {
      if (key === 'arrowup' || key === 'w') return { dc: 0, dr: -1 }
      if (key === 'arrowdown' || key === 's') return { dc: 0, dr: 1 }
      if (key === 'arrowleft' || key === 'a') return { dc: -1, dr: 0 }
      if (key === 'arrowright' || key === 'd') return { dc: 1, dr: 0 }
      return null
    }

    const pumpMove = () => {
      rafId = null
      if (isEditMode || exerciseScene !== null) {
        pressedKeys.clear()
        keyOrder.length = 0
        return
      }

      if (pressedKeys.size === 0) return

      const office = officeRef.current
      const player = office?.characters.get(PLAYER_CHARACTER_ID)
      if (!office || !player) {
        rafId = requestAnimationFrame(pumpMove)
        return
      }

      const isMoving = player.path.length > 0 || player.moveProgress > 0
      if (!isMoving) {
        for (let i = keyOrder.length - 1; i >= 0; i--) {
          const key = keyOrder[i]
          if (!pressedKeys.has(key)) continue
          const delta = getMoveDelta(key)
          if (!delta) continue
          void office.walkToTile(
            PLAYER_CHARACTER_ID,
            player.tileCol + delta.dc,
            player.tileRow + delta.dr,
          )
          break
        }
      }

      rafId = requestAnimationFrame(pumpMove)
    }

    const ensurePump = () => {
      if (rafId === null) rafId = requestAnimationFrame(pumpMove)
    }

    const onMoveKeyDown = (e: KeyboardEvent) => {
      if (isEditMode || exerciseScene !== null) return
      if (isTextInputTarget(e.target)) return

      const key = e.key.toLowerCase()
      if (!getMoveDelta(key)) return

      e.preventDefault()
      if (!pressedKeys.has(key)) {
        pressedKeys.add(key)
        const existing = keyOrder.indexOf(key)
        if (existing >= 0) keyOrder.splice(existing, 1)
        keyOrder.push(key)
      }
      ensurePump()
    }

    const onMoveKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (!getMoveDelta(key)) return
      pressedKeys.delete(key)
      const idx = keyOrder.indexOf(key)
      if (idx >= 0) keyOrder.splice(idx, 1)
    }

    const onBlur = () => {
      pressedKeys.clear()
      keyOrder.length = 0
    }

    window.addEventListener('keydown', onMoveKeyDown)
    window.addEventListener('keyup', onMoveKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      window.removeEventListener('keydown', onMoveKeyDown)
      window.removeEventListener('keyup', onMoveKeyUp)
      window.removeEventListener('blur', onBlur)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [exerciseScene, isEditMode])

  useEffect(() => {
    const onEnterKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      if (isEditMode) return
      if (exerciseScene !== null) return

      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return
      }

      const nearTaskId = nearExerciseTaskIdRef.current
      if (!nearTaskId) return

      e.preventDefault()
      openExerciseDialogue(nearTaskId)
    }

    window.addEventListener('keydown', onEnterKeyDown)
    return () => window.removeEventListener('keydown', onEnterKeyDown)
  }, [exerciseScene, isEditMode, openExerciseDialogue])

  // ── Editor toolbar callbacks ──────────────────────────────────
  const handleToolChange = useCallback((tool: EditTool) => {
    editorRef.current.activeTool = tool
    editorRef.current.clearSelection()
    forceEditorUpdate()
  }, [forceEditorUpdate])

  const handleTileTypeChange = useCallback((type: TileTypeVal) => {
    editorRef.current.selectedTileType = type
    forceEditorUpdate()
  }, [forceEditorUpdate])

  const handleFloorColorChange = useCallback((color: FloorColor) => {
    editorRef.current.floorColor = color
    forceEditorUpdate()
  }, [forceEditorUpdate])

  const handleWallColorChange = useCallback((color: FloorColor) => {
    editorRef.current.wallColor = color
    forceEditorUpdate()
  }, [forceEditorUpdate])

  const handleFurnitureTypeChange = useCallback((type: string) => {
    editorRef.current.selectedFurnitureType = type
    forceEditorUpdate()
  }, [forceEditorUpdate])

  const handleSelectedFurnitureColorChange = useCallback((color: FloorColor | null) => {
    const editor = editorRef.current
    const office = officeRef.current
    if (!office || !editor.selectedFurnitureUid) return
    const newLayout = {
      ...office.layout,
      furniture: office.layout.furniture.map(f =>
        f.uid === editor.selectedFurnitureUid ? { ...f, color: color ?? undefined } : f
      ),
    }
    applyEdit(newLayout)
  }, [applyEdit])

  const toggleEditMode = useCallback(() => {
    const editor = editorRef.current
    editor.isEditMode = !editor.isEditMode
    if (!editor.isEditMode) {
      editor.reset()
    }
    setIsEditMode(editor.isEditMode)
  }, [])

  const toggleSound = useCallback(() => {
    const newVal = !isSoundEnabled()
    setSoundEnabled(newVal)
    setSoundOn(newVal)
    localStorage.setItem('pixel-office-sound', String(newVal))
  }, [])

  const resetView = useCallback(() => {
    zoomRef.current = isMobileViewport ? MOBILE_CANVAS_ZOOM : DESKTOP_CANVAS_ZOOM
    panRef.current = { x: 0, y: 0 }
  }, [isMobileViewport])

  // ── Hovered agent tooltip data ──────────────────────────────
  const getHoveredAgentInfo = useCallback(() => {
    if (hoveredAgentId === null) return null
    const map = agentIdMapRef.current
    let agentId: string | null = null
    for (const [aid, cid] of map.entries()) {
      if (cid === hoveredAgentId) { agentId = aid; break }
    }
    if (agentId) {
      const agent = agents.find(a => a.agentId === agentId)
      const stats = agentStatsRef.current.get(agentId)
      return { kind: 'agent' as const, agent, stats, isSubagent: false as const, parentAgentId: null as string | null }
    }

    const hoveredCharacter = officeRef.current?.characters.get(hoveredAgentId)
    if (hoveredCharacter?.isSubagent && hoveredCharacter.parentAgentId != null) {
      let parentAgentId: string | null = null
      for (const [aid, cid] of map.entries()) {
        if (cid === hoveredCharacter.parentAgentId) { parentAgentId = aid; break }
      }
      if (!parentAgentId) return null
      const parentAgent = agents.find(a => a.agentId === parentAgentId)
      if (!parentAgent) return null
      return {
        kind: 'subagent' as const,
        agent: parentAgent,
        stats: agentStatsRef.current.get(parentAgentId),
        isSubagent: true as const,
        parentAgentId,
      }
    }

    const gatewaySre = officeRef.current?.getGatewaySreInfo()
    if (gatewaySre && gatewaySre.id === hoveredAgentId) {
      return { kind: 'gatewaySre' as const, gatewaySre }
    }
    return null
  }, [hoveredAgentId, agents])

  const hoveredInfo = getHoveredAgentInfo()

  const editor = editorRef.current
  const selectedItem = editor.selectedFurnitureUid
    ? officeRef.current?.layout.furniture.find(f => f.uid === editor.selectedFurnitureUid) : null
  const modalOverlayClass = isMobileViewport
    ? "absolute inset-0 z-20 flex items-end justify-center bg-black/50"
    : "absolute inset-0 z-20 flex items-center justify-center bg-black/40"
  const modalPanelClass = (desktopWidth = "w-80", maxHeight = "max-h-[80%]") =>
    isMobileViewport
      ? `w-full ${maxHeight} overflow-y-auto rounded-t-2xl border-x border-t border-[var(--border)] bg-[var(--card)] shadow-2xl p-4 pb-6`
      : `${desktopWidth} ${maxHeight} overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl p-4`
  const displayAgents = useMemo<AgentActivity[]>(() => {
    const expanded: AgentActivity[] = []
    for (const agent of agents) {
      expanded.push(agent)
      if (!agent.subagents?.length) continue
      for (const sub of agent.subagents) {
        const subKey = sub.sessionKey ? `${sub.sessionKey}::${sub.toolId}` : sub.toolId
        expanded.push({
          agentId: `subagent:${agent.agentId}:${subKey}`,
          name: `${t('pixelOffice.tempWorker')} ${agent.agentId}`,
          emoji: agent.emoji,
          state: 'working',
          lastActive: agent.lastActive,
        })
      }
    }
    return expanded
  }, [agents])

  const mobileAgentPages: AgentActivity[][] = []
  for (let i = 0; i < displayAgents.length; i += 9) {
    mobileAgentPages.push(displayAgents.slice(i, i + 9))
  }
  const renderAgentChip = (agent: AgentActivity, mobileGrid = false) => {
    const isTempWorker = agent.agentId.startsWith('subagent:')
    const parentAgentIdFromKey = isTempWorker ? (agent.agentId.split(':')[1] || '') : ''
    const tempWorkerOwner = isTempWorker ? (agent.name.replace(new RegExp(`^${t('pixelOffice.tempWorker')}\\s*`), '') || parentAgentIdFromKey) : ''
    const chipTooltip = isTempWorker
      ? `${tempWorkerOwner} ${t('pixelOffice.tempWorker.createdBy')}`
      : `agent id：${agent.agentId}`
    const chipToneClass = isTempWorker
      ? 'bg-red-900/45 border-red-700/80 text-red-100 animate-pulse'
      : (
        agent.state === 'working' ? `pixel-agent-chip-working${isMobileViewport ? '' : ' animate-pulse'}` :
        agent.state === 'idle' ? `pixel-agent-chip-idle${isMobileViewport ? '' : ' animate-pulse'}` :
        'pixel-agent-chip-neutral'
      )
    return (
      <div key={agent.agentId} className="group relative overflow-visible">
        <div className={`pixel-agent-chip inline-flex h-8 items-center overflow-hidden rounded-lg border transition-colors ${
          mobileGrid ? 'w-full min-w-0 gap-1.5 px-2 py-1.5' : 'shrink-0 gap-2 px-3 py-1.5'
        } ${chipToneClass}`}
          title={chipTooltip}
          aria-label={chipTooltip}
          {...(agent.state === 'working'
            ? { style: { animationDuration: isTempWorker ? '0.9s' : '1.3s' } }
            : {})}
        >
          <span className={mobileGrid ? 'shrink-0 text-sm' : ''}>{agent.emoji}</span>
          {isTempWorker ? (
            <span className={`min-w-0 flex flex-col justify-center ${mobileGrid ? 'max-w-[4.6rem]' : 'max-w-[5.8rem]'} leading-none`}>
              <span className={`${mobileGrid ? 'text-[10px]' : 'text-[12px]'} truncate`}>{t('pixelOffice.tempWorker')}</span>
              <span className={`${mobileGrid ? 'text-[10px]' : 'text-[12px]'} truncate`}>{tempWorkerOwner}</span>
            </span>
          ) : (
            <span className={mobileGrid ? 'min-w-0 text-xs truncate' : 'text-sm'}>{agent.name}</span>
          )}
          {agent.state === 'working' && <span className={`pixel-agent-chip-state uppercase tracking-wider ${mobileGrid ? 'text-[9px] truncate' : 'text-[10px]'} ${isTempWorker ? 'text-red-100' : 'text-green-200'}`}>{t('pixelOffice.state.working')}</span>}
          {agent.state === 'idle' && <span className={`pixel-agent-chip-state uppercase tracking-wider ${mobileGrid ? 'text-[9px] truncate' : 'text-[10px]'}`}>{t('pixelOffice.state.idle')}</span>}
          {agent.state === 'offline' && <span className={`pixel-agent-chip-state uppercase tracking-wider ${mobileGrid ? 'text-[9px] truncate' : 'text-[10px]'}`}>{t('pixelOffice.state.offline')}</span>}
          {agent.state === 'waiting' && <span className={`pixel-agent-chip-state uppercase tracking-wider ${mobileGrid ? 'text-[9px] truncate' : 'text-[10px]'}`}>{t('pixelOffice.state.waiting')}</span>}
        </div>
        {!isMobileViewport && (
          <div className="pointer-events-none absolute left-1/2 top-0 z-20 -translate-x-1/2 -translate-y-[calc(100%+6px)] whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--card)]/95 px-2 py-1 text-[11px] text-[var(--text)] opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100">
            {chipTooltip}
          </div>
        )}
      </div>
    )
  }

  if (PIXEL_OFFICE_FOCUS_ONLY) {
    return (
      <div className="h-[100dvh] w-full bg-[#1a1a2e] pt-8 md:pt-12 pb-6 md:pb-8 px-4 md:px-8 box-border">
        <div ref={containerRef} className="relative h-full w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[#1a1a2e] max-w-[1600px] mx-auto">
          <canvas
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onContextMenu={handleContextMenu}
            className="h-full w-full"
            style={{ touchAction: 'none' }}
          />
          {!officeReady && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#1a1a2e]/85 pointer-events-none">
              <div className="px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm text-[var(--text-muted)]">
                {t('common.loading')}
              </div>
            </div>
          )}
          {activeExerciseTask && exerciseScene === 'dialogue' && (
            <div
              className="absolute inset-0 z-30 flex items-center justify-center bg-black/65 backdrop-blur-[3px]"
              onClick={closeExerciseScene}
            >
              <div
                className="w-[min(92vw,720px)] flex flex-col items-center gap-3 md:gap-4"
                onClick={(event) => event.stopPropagation()}
              >
                <img
                  src="/assets/pixel-office/hacker.png"
                  alt="Hacker"
                  className="w-[min(60vw,290px)] h-auto select-none drop-shadow-[0_8px_16px_rgba(0,0,0,0.55)]"
                  draggable={false}
                />

                <div className="relative w-[min(92vw,720px)]">
                  <img
                    src="/assets/pixel-office/framechat.png"
                    alt="Chat frame"
                    className="block w-full h-auto select-none"
                    draggable={false}
                  />
                  <div className="absolute left-[6.5%] right-[6.5%] top-[16%] bottom-[8.5%] overflow-hidden">
                    <p className="pixel-chat-text h-full w-full whitespace-pre-wrap break-words overflow-hidden">
                      {activeDialogueLine.slice(0, dialogueTypedLength)}
                      {!isDialogueLineComplete && <span className="animate-pulse">▋</span>}
                    </p>
                  </div>
                </div>

                <div className="w-[min(92vw,560px)] flex flex-col items-center gap-2">
                  <div className="w-full flex items-center justify-center gap-2">
                    <button
                      onClick={handleDialogueBack}
                      disabled={dialogueLineIndex === 0}
                      className="p-0 border-0 bg-transparent disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label="Back"
                    >
                      <img
                        src="/assets/pixel-office/back.png"
                        alt="Back"
                        className="h-[38px] md:h-[42px] w-auto select-none"
                        draggable={false}
                      />
                    </button>
                    <button
                      onClick={handleDialogueNext}
                      className="p-0 border-0 bg-transparent"
                      aria-label="Next"
                    >
                      <img
                        src="/assets/pixel-office/next.png"
                        alt="Next"
                        className="h-[38px] md:h-[42px] w-auto select-none"
                        draggable={false}
                      />
                    </button>
                  </div>
                  <button
                    onClick={goExerciseGameplay}
                    className="p-0 border-0 bg-transparent"
                    aria-label="Skip"
                  >
                    <img
                      src="/assets/pixel-office/skip.png"
                      alt="Skip"
                      className="h-[38px] md:h-[42px] w-auto select-none"
                      draggable={false}
                    />
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeExerciseTask && exerciseScene === 'gameplay' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/72 px-2 md:px-4 backdrop-blur-[2px]">
              <div className="pixel-exercise-ui relative w-[min(97vw,1300px)] min-w-[310px]">
                <div className="relative aspect-[886/413] w-full">
                  <div
                    className="absolute left-0 top-[0.7%] h-[98.6%] w-[74.8%] bg-no-repeat"
                    style={{ backgroundImage: "url('/assets/pixel-office/button_02.png')", backgroundSize: '100% 100%' }}
                  >
                    <div
                      className="absolute left-[5%] top-[5%] bottom-[5%] h-[20%] w-[89%] bg-no-repeat"
                      style={{ backgroundImage: "url('/assets/pixel-office/button_07.png')", backgroundSize: '100% 100%' }}
                    >
                      <div className="pixel-exercise-title absolute inset-[11%_3.8%_9%_3.8%] overflow-y-auto px-2 text-center text-[#233f66] text-[clamp(7px,1vw,16px)] font-bold tracking-wide whitespace-pre-wrap leading-[1.35]">
                        Tham dự phiên họp có đồng chí Võ Thị Ánh Xuân, Bí thư Trung ương Đảng, Phó Chủ tịch nước, Phó Chủ tịch Thứ nhất Hội đồng; đồng chí Phạm Thị Thanh Trà, Bí thư Trung ương Đảng, Phó Thủ tướng Chính phủ; đồng chí Đỗ Thanh Bình, Ủy viên Trung ương Đảng, Bộ trưởng Bộ Nội vụ, Phó Chủ tịch Thường trực Hội đồng; các đồng chí Ủy viên Trung ương Đảng, lãnh đạo Mặt trận Tổ quốc Việt Nam, các bộ, ngành, cơ quan Trung ương là Ủy viên Hội đồng.Tham dự phiên họp có đồng chí Võ Thị Ánh Xuân, Bí thư Trung ương Đảng, Phó Chủ tịch nước, Phó Chủ tịch Thứ nhất Hội đồng; đồng chí Phạm Thị Thanh Trà, Bí thư Trung ương Đảng, Phó Thủ tướng Chính phủ; đồng chí Đỗ Thanh Bình, Ủy viên Trung ương Đảng, Bộ trưởng Bộ Nội vụ, Phó Chủ tịch Thường trực Hội đồng; các đồng chí Ủy viên Trung ương Đảng, lãnh đạo Mặt trận Tổ quốc Việt Nam, các bộ, ngành, cơ quan Trung ương là Ủy viên Hội đồng.Tham dự phiên họp có đồng chí Võ Thị Ánh Xuân, Bí thư Trung ương Đảng, Phó Chủ tịch nước, Phó Chủ tịch Thứ nhất Hội đồng; đồng chí Phạm Thị Thanh Trà, Bí thư Trung ương Đảng, Phó Thủ tướng Chính phủ; đồng chí Đỗ Thanh Bình, Ủy viên Trung ương Đảng, Bộ trưởng Bộ Nội vụ, Phó Chủ tịch Thường trực Hội đồng; các đồng chí Ủy viên Trung ương Đảng, lãnh đạo Mặt trận Tổ quốc Việt Nam, các bộ, ngành, cơ quan Trung ương là Ủy viên Hội đồng.Tham dự phiên họp có đồng chí Võ Thị Ánh Xuân, Bí thư Trung ương Đảng, Phó Chủ tịch nước, Phó Chủ tịch Thứ nhất Hội đồng; đồng chí Phạm Thị Thanh Trà, Bí thư Trung ương Đảng, Phó Thủ tướng Chính phủ; đồng chí Đỗ Thanh Bình, Ủy viên Trung ương Đảng, Bộ trưởng Bộ Nội vụ, Phó Chủ tịch Thường trực Hội đồng; các đồng chí Ủy viên Trung ương Đảng, lãnh đạo Mặt trận Tổ quốc Việt Nam, các bộ, ngành, cơ quan Trung ương là Ủy viên Hội đồng.Tham dự phiên họp có đồng chí Võ Thị Ánh Xuân, Bí thư Trung ương Đảng, Phó Chủ tịch nước, Phó Chủ tịch Thứ nhất Hội đồng; đồng chí Phạm Thị Thanh Trà, Bí thư Trung ương Đảng, Phó Thủ tướng Chính phủ; đồng chí Đỗ Thanh Bình, Ủy viên Trung ương Đảng, Bộ trưởng Bộ Nội vụ, Phó Chủ tịch Thường trực Hội đồng; các đồng chí Ủy viên Trung ương Đảng, lãnh đạo Mặt trận Tổ quốc Việt Nam, các bộ, ngành, cơ quan Trung ương là Ủy viên Hội đồng.Tham dự phiên họp có đồng chí Võ Thị Ánh Xuân, Bí thư Trung ương Đảng, Phó Chủ tịch nước, Phó Chủ tịch Thứ nhất Hội đồng; đồng chí Phạm Thị Thanh Trà, Bí thư Trung ương Đảng, Phó Thủ tướng Chính phủ; đồng chí Đỗ Thanh Bình, Ủy viên Trung ương Đảng, Bộ trưởng Bộ Nội vụ, Phó Chủ tịch Thường trực Hội đồng; các đồng chí Ủy viên Trung ương Đảng, lãnh đạo Mặt trận Tổ quốc Việt Nam, các bộ, ngành, cơ quan Trung ương là Ủy viên Hội đồng.
                      </div>
                    </div>

                    <div
                      className="absolute left-[4.15%] top-[27.8%] h-[55.4%] w-[91.7%] bg-no-repeat"
                      style={{ backgroundImage: "url('/assets/pixel-office/panel_01.png')", backgroundSize: '100% 100%' }}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault()
                        const nextSkill = event.dataTransfer.getData('text/plain')
                        if (nextSkill) {
                          // Nhóm 3 skill đặc biệt: Đánh giá tên miền giả mạo, Tạo website giả mạo, Mã độc capcha
                          const isSpecialSkill = CAPCHA_SKILL_GROUP.includes(nextSkill as typeof CAPCHA_SKILL_GROUP[number])
                          const hasSpecialSkill = droppedSkills.some(s => CAPCHA_SKILL_GROUP.includes(s as typeof CAPCHA_SKILL_GROUP[number]))
                          
                          if (isSpecialSkill) {
                            // Nếu đang có skill thường: không được thêm skill đặc biệt
                            if (droppedSkills.length > 0 && !hasSpecialSkill) {
                              return
                            }
                            // Skill đặc biệt: thả cùng lúc được với các skill đặc biệt khác
                            if (!droppedSkills.includes(nextSkill)) {
                              setDroppedSkills(prev => [...prev, nextSkill])
                            }
                            // Set as main skill if first one
                            if (droppedSkills.length === 0) {
                              setDroppedGameplaySkill(nextSkill)
                            }
                          } else {
                            // Skill thường: chỉ được thả độc lập (xóa tất cả skill cũ)
                            setDroppedSkills([nextSkill])
                            setDroppedGameplaySkill(nextSkill)
                          }
                          // Reset skill-specific inputs when new skill is dropped
                          setDictionaryDecodeText('')
                          setDictionaryDecodeResult('')
                          setXorHoaCiphertext('')
                          setXorHoaDataFormat('')
                          setXorHoaKey('')
                          setXorHoaKeyType('')
                          setXorHoaDecryptResult('')
                          setRunningKeyCiphertext('')
                          setRunningKeyKey('')
                          setRunningKeyDecryptResult('')
                          setEncryptRunningKeyPlaintext('')
                          setEncryptRunningKey('')
                          setEncryptRunningKeyResult('')
                          setMatrixImageData(Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => Math.random() < 0.3 ? 1 : 0)))
                          setMatrixImageResult('')
                          setMatrixCumulativeData(Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => Math.random() < 0.3 ? 1 : 0)))
                          setMatrixCumulativeResult('')
                          setMatrixEncryptData(Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => Math.random() < 0.3 ? 1 : 0)))
                          setMatrixEncryptResult('')
                          setWordlistContent(`admin
password
123456
letmein
qwerty
abc123
monkey
master
dragon
login
welcome
shadow
sunshine
princess
football
iloveyou
michael
ninja
mustang
batman`)
                          setMorsePlaintext('')
                          setMorseResult('')
                          setPasswordSearchKeyword('')
                          setPasswordSearchResult('')
                          setPacketCaptureResult('')
                          setReplayPacketNumber('')
                          setReplayField1Name('')
                          setReplayField1Value('')
                          setReplayField2Name('')
                          setReplayField2Value('')
                          setReplayField3Name('')
                          setReplayField3Value('')
                          setReplayField4Name('')
                          setReplayField4Value('')
                          setPacketReplayResult('')
                          setFakeDomainInput('')
                          setDomainEvaluationResult('')
                          setSelectedFakeWebsite('')
                          setCapchaMalwareResult('')
                        }
                      }}
                    >
                      {/* Loa: chỉ hiện ở bài 1, trong ô kéo thả, góc trên bên phải - phát giaidoan1.mp3 */}
                      {activeExerciseTaskId === 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            unlockAudio()
                            playLessonAudio()
                          }}
                          className="absolute right-[2%] top-[2%] w-8 h-8 border-0 bg-transparent p-0 cursor-pointer z-50"
                          title="Nghe đoạn văn bản"
                        >
                          <img
                            src="/assets/pixel-office/loudspeaker.png"
                            alt="Loa"
                            className={`w-full h-full object-contain ${soundOn ? '' : 'opacity-50'}`}
                            draggable={false}
                          />
                        </button>
                      )}
                      {/* Inner container - full scrollable area */}
                      <div className="absolute inset-[8%_6%_8%_6%] overflow-y-auto overflow-x-hidden">
                        {/* Dropped skill button(s) - show all dropped skills */}
                        {droppedSkills.length > 0 && (
                          <div className="mt-[2%] flex flex-wrap gap-2">
                            {droppedSkills.map((skill) => (
                              <button
                                key={skill}
                                type="button"
                                onClick={() => {
                                  // Remove this skill from droppedSkills
                                  setDroppedSkills(prev => prev.filter(s => s !== skill))
                                  // If it was the main droppedGameplaySkill, clear it
                                  if (droppedGameplaySkill === skill) {
                                    setDroppedGameplaySkill(null)
                                  }
                                }}
                                className="relative"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold px-2">{skill}</span>
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Thông báo capcha - chỉ hiện khi đủ 3 skill */}
                        {droppedSkills.includes('Đánh giá tên miền giả mạo') && 
                         droppedSkills.includes('Tạo website giả mạo') && 
                         droppedSkills.includes('Mã độc capcha') && (
                          <div className="mt-4 text-center">
                            <span className="text-[#228B22] text-[clamp(10px,1vw,15px)] font-bold uppercase tracking-wide">
                              ĐÃ THÊM MÃ ĐỘC CAPCHA
                            </span>
                          </div>
                        )}

                        

                        

                        {/* Giải mã hóa bằng từ điển */}
                        {droppedGameplaySkill === 'Giải mã hóa bằng từ điển' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Input bản mã */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <input
                                value={dictionaryDecodeText}
                                onChange={(event) => setDictionaryDecodeText(event.target.value)}
                                placeholder="Nhập văn bản cần giải mã..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                              />
                            </div>
                            {/* Select bộ từ điển */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <select
                                value={xorHoaDataFormat}
                                onChange={(event) => setXorHoaDataFormat(event.target.value)}
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none cursor-pointer appearance-none"
                              >
                                <option value="" disabled className="text-[#5a7a9a]">Chọn bộ từ điển...</option>
                                <option value="morse">Từ điển sát nghĩa</option>
                                <option value="vietnamese">Từ điển Ticte</option>
                                <option value="binary">Từ điển Tây Bắc</option>
                              </select>
                            </div>
                            {/* Button Giải mã */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Dictionary Decode:', dictionaryDecodeText, xorHoaDataFormat);
                                  if (dictionaryDecodeText && xorHoaDataFormat) {
                                    // Logic: Đúng input "yhfundhcg" VÀ đúng từ điển "binary" (Tây Bắc)
                                    if (dictionaryDecodeText.toLowerCase() === 'yhfundhcg' && xorHoaDataFormat === 'binary') {
                                      setDictionaryDecodeResult(`Kết quả giải mã: blockchainptit`);
                                    } else {
                                      setDictionaryDecodeResult(`Kết quả giải mã: ${dictionaryDecodeText}`);
                                    }
                                  }
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Giải mã</span>
                              </button>
                            </div>
                            {dictionaryDecodeResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {dictionaryDecodeResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Giải mã hóa bằng XOR */}
                        {droppedGameplaySkill === 'Giải mã hóa bằng XOR' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Bản mã input */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <input
                                value={xorHoaCiphertext}
                                onChange={(event) => setXorHoaCiphertext(event.target.value)}
                                placeholder="Nhập bản mã..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                              />
                            </div>
                            
                            {/* Submit button - 1/3 width */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('XOR Hoa Decrypt:', { ciphertext: xorHoaCiphertext, dataFormat: xorHoaDataFormat, key: xorHoaKey, keyType: xorHoaKeyType })
                                  if (xorHoaCiphertext && xorHoaKey && xorHoaDataFormat && xorHoaKeyType) {
                                    setXorHoaDecryptResult(`Bản rõ XOR: ${xorHoaCiphertext}`)
                                  }
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {xorHoaDecryptResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {xorHoaDecryptResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Giải mã bằng khóa chạy */}
                        {droppedGameplaySkill === 'Giải mã bằng khóa chạy' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Bản mã */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <input
                                value={runningKeyCiphertext}
                                onChange={(event) => setRunningKeyCiphertext(event.target.value)}
                                placeholder="Nhập bản mã..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                              />
                            </div>
                            {/* Khóa chạy */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <input
                                value={runningKeyKey}
                                onChange={(event) => setRunningKeyKey(event.target.value)}
                                placeholder="Nhập khóa chạy..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                              />
                            </div>
                            {/* Button - 1/3 width */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Running Key Decrypt:', { ciphertext: runningKeyCiphertext, key: runningKeyKey })
                                  if (runningKeyCiphertext && runningKeyKey) {
                                    setRunningKeyDecryptResult(`Bản rõ: ${runningKeyCiphertext} (khóa: ${runningKeyKey})`)
                                  }
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Giải mã</span>
                              </button>
                            </div>
                            {runningKeyDecryptResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {runningKeyDecryptResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Mã hóa bằng khóa chạy */}
                        {droppedGameplaySkill === 'Mã hóa bằng khóa chạy' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Bản rõ */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <input
                                value={encryptRunningKeyPlaintext}
                                onChange={(event) => setEncryptRunningKeyPlaintext(event.target.value)}
                                placeholder="Nhập bản rõ..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                              />
                            </div>
                            {/* Khóa chạy */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <input
                                value={encryptRunningKey}
                                onChange={(event) => setEncryptRunningKey(event.target.value)}
                                placeholder="Nhập khóa chạy..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                              />
                            </div>
                            {/* Button - 1/3 width */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Running Key Encrypt:', { plaintext: encryptRunningKeyPlaintext, key: encryptRunningKey })
                                  if (encryptRunningKeyPlaintext && encryptRunningKey) {
                                    // Logic: Đúng input "blockchainptit" VÀ đúng khóa "taybac"
                                    if (encryptRunningKeyPlaintext.toLowerCase() === 'blockchainptit' && encryptRunningKey.toLowerCase() === 'taybac') {
                                      setEncryptRunningKeyResult(`Bản mã: mahoa`)
                                    } else {
                                      setEncryptRunningKeyResult(`Bản mã: ${encryptRunningKeyPlaintext} (khóa: ${encryptRunningKey})`)
                                    }
                                  }
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {encryptRunningKeyResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {encryptRunningKeyResult}
                              </div>
                            )}
                          </div>
                        )}

{/* Biến ma trận số thành ảnh */}
                        {droppedGameplaySkill === 'Biến ma trận số thành ảnh' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            <div className="text-[#233f66] text-[clamp(9px,0.9vw,14px)] text-center mb-1">
                               
                            </div>
                            {/* Download button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  const link = document.createElement('a')
                                  link.href = '/file/matrix.xlsx'
                                  link.download = 'matrix1.xlsx'
                                  link.click()
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(84px, 12vw, 120px)', backgroundImage: "url('/assets/pixel-office/download.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              />
                            </div>
                            {/* 21x21 Grid */}
                            <div className="flex justify-center">
                              <div className="inline-grid gap-[1px] bg-[#233f66] p-[2px] rounded" style={{ gridTemplateColumns: 'repeat(21, minmax(0, 1fr))' }}>
                                {matrixImageData.map((row, rowIndex) =>
                                  row.map((cell, colIndex) => (
                                    <button
                                      key={`${rowIndex}-${colIndex}`}
                                      type="button"
                                      onClick={() => {
                                        const newData = matrixImageData.map((r, ri) =>
                                          r.map((c, ci) => (ri === rowIndex && ci === colIndex) ? (c === 0 ? 1 : 0) : c)
                                        )
                                        setMatrixImageData(newData)
                                      }}
                                      className="w-[clamp(6px,0.9vw,12px)] h-[clamp(6px,0.9vw,12px)] border-0 cursor-pointer transition-colors flex items-center justify-center"
                                      style={{
                                        backgroundColor: cell === 1 ? '#1a1a1a' : '#ffffff',
                                      }}
                                      aria-label={`Hàng ${rowIndex + 1}, Cột ${colIndex + 1}: ${cell}`}
                                    >
                                      <span className="text-[clamp(4px,0.6vw,8px)] font-bold" style={{ color: cell === 1 ? '#ffffff' : '#1a1a1a' }}>
                                        {cell}
                                      </span>
                                    </button>
                                  ))
                                )}
                              </div>
                            </div>
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Matrix Image:', matrixImageData)
                                  // Convert matrix to binary string for flag
                                  const binaryString = matrixImageData.flat().join('')
                                  setMatrixImageResult(`Ma trận đã gửi: ${binaryString.slice(0, 20)}...`)
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {matrixImageResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {matrixImageResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Mã hóa ma trận bằng cộng dồn */}
                        {droppedGameplaySkill === 'Biến ma trận thành ma trận xoắn ốc' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            <div className="text-[#233f66] text-[clamp(9px,0.9vw,14px)] text-center mb-1">
                            
                            </div>
                            {/* Download button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  const link = document.createElement('a')
                                  link.href = '/file/matrix.xlsx'
                                  link.download = 'matrix.xlsx'
                                  link.click()
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(84px, 12vw, 120px)', backgroundImage: "url('/assets/pixel-office/download.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              />
                            </div>
                            {/* 21x21 Grid */}
                            <div className="flex justify-center">
                              <div className="inline-grid gap-[1px] bg-[#233f66] p-[2px] rounded" style={{ gridTemplateColumns: 'repeat(21, minmax(0, 1fr))' }}>
                                {matrixCumulativeData.map((row, rowIndex) =>
                                  row.map((cell, colIndex) => (
                                    <button
                                      key={`${rowIndex}-${colIndex}`}
                                      type="button"
                                      onClick={() => {
                                        const newData = matrixCumulativeData.map((r, ri) =>
                                          r.map((c, ci) => (ri === rowIndex && ci === colIndex) ? (c === 0 ? 1 : 0) : c)
                                        )
                                        setMatrixCumulativeData(newData)
                                      }}
                                      className="w-[clamp(6px,0.9vw,12px)] h-[clamp(6px,0.9vw,12px)] border-0 cursor-pointer transition-colors flex items-center justify-center"
                                      style={{
                                        backgroundColor: cell === 1 ? '#1a1a1a' : '#ffffff',
                                      }}
                                      aria-label={`Hàng ${rowIndex + 1}, Cột ${colIndex + 1}: ${cell}`}
                                    >
                                      <span className="text-[clamp(4px,0.6vw,8px)] font-bold" style={{ color: cell === 1 ? '#ffffff' : '#1a1a1a' }}>
                                        {cell}
                                      </span>
                                    </button>
                                  ))
                                )}
                              </div>
                            </div>
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Matrix Cumulative:', matrixCumulativeData)
                                  const binaryString = matrixCumulativeData.flat().join('')
                                  setMatrixCumulativeResult(`Ma trận xoắn ốc: ${binaryString.slice(0, 20)}...`)
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {matrixCumulativeResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {matrixCumulativeResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Phân cụm ma trận  */}
                        {droppedGameplaySkill === 'Phân cụm ma trận' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            <div className="text-[#233f66] text-[clamp(9px,0.9vw,14px)] text-center mb-1">
                              
                            </div>
                            {/* Download button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  const link = document.createElement('a')
                                  link.href = '/file/matrix.xlsx'
                                  link.download = 'matrix.xlsx'
                                  link.click()
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(84px, 12vw, 120px)', backgroundImage: "url('/assets/pixel-office/download.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              />
                            </div>
                            {/* 21x21 Grid */}
                            <div className="flex justify-center">
                              <div className="inline-grid gap-[1px] bg-[#233f66] p-[2px] rounded" style={{ gridTemplateColumns: 'repeat(21, minmax(0, 1fr))' }}>
                                {matrixEncryptData.map((row, rowIndex) =>
                                  row.map((cell, colIndex) => (
                                    <button
                                      key={`${rowIndex}-${colIndex}`}
                                      type="button"
                                      onClick={() => {
                                        const newData = matrixEncryptData.map((r, ri) =>
                                          r.map((c, ci) => (ri === rowIndex && ci === colIndex) ? (c === 0 ? 1 : 0) : c)
                                        )
                                        setMatrixEncryptData(newData)
                                      }}
                                      className="w-[clamp(6px,0.9vw,12px)] h-[clamp(6px,0.9vw,12px)] border-0 cursor-pointer transition-colors flex items-center justify-center"
                                      style={{
                                        backgroundColor: cell === 1 ? '#1a1a1a' : '#ffffff',
                                      }}
                                      aria-label={`Hàng ${rowIndex + 1}, Cột ${colIndex + 1}: ${cell}`}
                                    >
                                      <span className="text-[clamp(4px,0.6vw,8px)] font-bold" style={{ color: cell === 1 ? '#ffffff' : '#1a1a1a' }}>
                                        {cell}
                                      </span>
                                    </button>
                                  ))
                                )}
                              </div>
                            </div>
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Matrix Encrypt:', matrixEncryptData)
                                  const binaryString = matrixEncryptData.flat().join('')
                                  setMatrixEncryptResult(`Ma trận mã hóa: ${binaryString.slice(0, 20)}...`)
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {matrixEncryptResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {matrixEncryptResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Dò mật khẩu dựa trên từ vựng */}
                        {droppedGameplaySkill === 'Dò mật khẩu dựa trên từ vựng' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            <div className="text-[#233f66] text-[clamp(9px,0.9vw,14px)] text-center mb-1">
                              Wordlist (mỗi từ 1 dòng)
                            </div>
                            {/* Wordlist textarea */}
                            <div className="relative w-full rounded overflow-hidden" style={{ height: 'clamp(150px, 30vw, 280px)', backgroundImage: "url('/assets/pixel-office/frame.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <textarea
                                value={wordlistContent}
                                onChange={(event) => setWordlistContent(event.target.value)}
                                placeholder="Nhập wordlist..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent pt-[15px] pl-[15px] pb-[15px] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none resize-none"
                                style={{ background: 'transparent' }}
                              />
                            </div>
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Wordlist:', wordlistContent)
                                  const words = wordlistContent.split('\n').filter(w => w.trim().length > 0)
                                  setMatrixEncryptResult(`Wordlist: ${words.length} từ`)
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {matrixEncryptResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {matrixEncryptResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Tạo mã morse */}
                        {droppedGameplaySkill === 'Tạo mã morse' && (
                          <MorseCodeComponent morsePlaintext={morsePlaintext} setMorsePlaintext={setMorsePlaintext} morseResult={morseResult} setMorseResult={setMorseResult} />
                        )}

                        {/* Dò tìm mật khẩu online */}
                        {droppedGameplaySkill === 'Dò tìm mật khẩu online' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Input search: Từ khóa tìm kiếm */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <input
                                value={passwordSearchKeyword}
                                onChange={(event) => setPasswordSearchKeyword(event.target.value)}
                                placeholder="Từ khóa tìm kiếm..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                              />
                            </div>
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Password Search:', { keyword: passwordSearchKeyword })
                                  setPasswordSearchResult(`Đã tìm: ${passwordSearchKeyword}`)
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {passwordSearchResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {passwordSearchResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Dò mật khẩu theo quy tắc */}
                        {droppedGameplaySkill === 'Dò mật khẩu theo quy tắc' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Select: Quy tắc */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <select
                                value={passwordRuleSelection}
                                onChange={(event) => setPasswordRuleSelection(event.target.value)}
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(7px,0.7vw,11px)] text-[#2d4e79] outline-none cursor-pointer appearance-none"
                              >
                                <option value="" disabled className="text-[#5a7a9a]">Chọn quy tắc...</option>
                                <option value="adjacent_numbers">Số gần nhau</option>
                                <option value="adjacent_letters">Chữ gần nhau</option>
                                <option value="even_spacing">Chữ cách đều</option>
                              </select>
                            </div>
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Password Rule:', passwordRuleSelection)
                                  setPasswordRuleResult(`Quy tắc: ${passwordRuleSelection}`)
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(7px,0.8vw,12px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {passwordRuleResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(6px,0.7vw,10px)] break-words">
                                {passwordRuleResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Dò mật khẩu từ bàn phím */}
                        {droppedGameplaySkill === 'Dò mật khẩu từ bàn phím' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Keyboard Password')
                                  setKeyboardPasswordResult('Đã dò mật khẩu từ bàn phím')
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(7px,0.8vw,12px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {keyboardPasswordResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(6px,0.7vw,10px)] break-words">
                                {keyboardPasswordResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Mã độc keylogger */}
                        {droppedGameplaySkill === 'Mã độc keylogger' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Keylogger')
                                  setKeyloggerResult('Đã phân tích mã độc keylogger')
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(7px,0.8vw,12px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {keyloggerResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(6px,0.7vw,10px)] break-words">
                                {keyloggerResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Chặn bắt gói tin */}
                        {droppedGameplaySkill === 'Chặn bắt gói tin' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Packet Capture')
                                  setPacketCaptureResult('Đã chặn bắt gói tin')
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {packetCaptureResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {packetCaptureResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Phát lại gói tin */}
                        {droppedGameplaySkill === 'Phát lại gói tin' && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            {/* Input text: Số gói tin */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <input
                                value={replayPacketNumber}
                                onChange={(event) => setReplayPacketNumber(event.target.value)}
                                placeholder="Số gói tin..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                              />
                            </div>
                            {/* Field 1 */}
                            <div className="flex gap-2">
                              <div className="relative w-1/2" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                                <input
                                  value={replayField1Name}
                                  onChange={(event) => setReplayField1Name(event.target.value)}
                                  placeholder="Trường 1..."
                                  className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(8px,0.8vw,12px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                                />
                              </div>
                              <div className="relative w-1/2" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                                <input
                                  value={replayField1Value}
                                  onChange={(event) => setReplayField1Value(event.target.value)}
                                  placeholder="Giá trị 1..."
                                  className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(8px,0.8vw,12px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                                />
                              </div>
                            </div>
                            {/* Field 2 */}
                            <div className="flex gap-2">
                              <div className="relative w-1/2" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                                <input
                                  value={replayField2Name}
                                  onChange={(event) => setReplayField2Name(event.target.value)}
                                  placeholder="Trường 2..."
                                  className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(8px,0.8vw,12px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                                />
                              </div>
                              <div className="relative w-1/2" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                                <input
                                  value={replayField2Value}
                                  onChange={(event) => setReplayField2Value(event.target.value)}
                                  placeholder="Giá trị 2..."
                                  className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(8px,0.8vw,12px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                                />
                              </div>
                            </div>
                            {/* Field 3 */}
                            <div className="flex gap-2">
                              <div className="relative w-1/2" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                                <input
                                  value={replayField3Name}
                                  onChange={(event) => setReplayField3Name(event.target.value)}
                                  placeholder="Trường 3..."
                                  className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(8px,0.8vw,12px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                                />
                              </div>
                              <div className="relative w-1/2" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                                <input
                                  value={replayField3Value}
                                  onChange={(event) => setReplayField3Value(event.target.value)}
                                  placeholder="Giá trị 3..."
                                  className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(8px,0.8vw,12px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                                />
                              </div>
                            </div>
                            {/* Field 4 */}
                            <div className="flex gap-2">
                              <div className="relative w-1/2" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                                <input
                                  value={replayField4Name}
                                  onChange={(event) => setReplayField4Name(event.target.value)}
                                  placeholder="Trường 4..."
                                  className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(8px,0.8vw,12px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                                />
                              </div>
                              <div className="relative w-1/2" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                                <input
                                  value={replayField4Value}
                                  onChange={(event) => setReplayField4Value(event.target.value)}
                                  placeholder="Giá trị 4..."
                                  className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(8px,0.8vw,12px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                                />
                              </div>
                            </div>
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Packet Replay:', { 
                                    packetNumber: replayPacketNumber, 
                                    field1: { name: replayField1Name, value: replayField1Value },
                                    field2: { name: replayField2Name, value: replayField2Value },
                                    field3: { name: replayField3Name, value: replayField3Value },
                                    field4: { name: replayField4Name, value: replayField4Value }
                                  })
                                  setPacketReplayResult(`Gói tin: ${replayPacketNumber} | ${replayField1Name}: ${replayField1Value} | ${replayField2Name}: ${replayField2Value} | ${replayField3Name}: ${replayField3Value} | ${replayField4Name}: ${replayField4Value}`)
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Submit</span>
                              </button>
                            </div>
                            {packetReplayResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {packetReplayResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Đánh giá tên miền giả mạo (skill 1) */}
                        {(droppedGameplaySkill === 'Đánh giá tên miền giả mạo' || droppedSkills.includes('Đánh giá tên miền giả mạo')) && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            <div className="text-[#233f66] text-[clamp(9px,0.9vw,14px)] font-semibold mb-1">
                              Nhập tên miền giả mạo
                            </div>
                            {/* Input tên miền giả mạo */}
                            <div className="relative w-full" style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}>
                              <input
                                value={fakeDomainInput}
                                onChange={(event) => setFakeDomainInput(event.target.value)}
                                placeholder="Nhập tên miền giả mạo (ví dụ: faceb00k.com)..."
                                className="absolute inset-0 w-full h-full border-0 bg-transparent px-[3%] text-[clamp(9px,0.9vw,14px)] text-[#2d4e79] outline-none placeholder:text-[#5a7a9a]"
                              />
                            </div>
                            {/* Nút đánh giá tên miền */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Evaluate Domain:', fakeDomainInput)
                                  if (fakeDomainInput) {
                                    // Simple evaluation - calculate similarity score
                                    const domain = fakeDomainInput.toLowerCase()
                                    let score = 0
                                    // Check for common target domains
                                    if (domain.includes('facebook') || domain.includes('fb')) score += 30
                                    if (domain.includes('google') || domain.includes('gogle') || domain.includes('googel')) score += 30
                                    if (domain.includes('apple') || domain.includes('appple') || domain.includes('aple')) score += 30
                                    if (domain.includes('microsoft') || domain.includes('microsft')) score += 30
                                    if (domain.includes('amazon') || domain.includes('amaz0n')) score += 30
                                    if (domain.includes('netflix')) score += 30
                                    if (domain.includes('paypal') || domain.includes('paypa1')) score += 30
                                    // Check for typosquatting indicators
                                    if (domain.replace(/[aeio]/g, '').length < domain.length - 2) score += 10 // letter substitution
                                    if (/[0-9]/.test(domain)) score += 5 // number substitution
                                    if (domain.length > 10) score += 5
                                    score = Math.min(score, 100)
                                    setDomainEvaluationResult(`Độ giả mạo: ${score}%`)
                                  }
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Đánh giá</span>
                              </button>
                            </div>
                            {domainEvaluationResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {domainEvaluationResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Tạo website giả mạo (skill 2) */}
                        {(droppedGameplaySkill === 'Tạo website giả mạo' || droppedSkills.includes('Tạo website giả mạo')) && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            <div className="text-[#233f66] text-[clamp(9px,0.9vw,14px)] font-semibold mb-1">
                              Tạo website giả mạo
                            </div>
                            {/* Danh sách website để chọn */}
                            <div className="flex flex-col gap-2">
                              {[
                                { id: 'facebook', name: 'Facebook', icon: '📘' },
                                { id: 'google', name: 'Google', icon: '🔍' },
                                { id: 'microsoft', name: 'Microsoft', icon: '🪟' }
                              ].map((site) => (
                                <button
                                  key={site.id}
                                  type="button"
                                  onClick={() => setSelectedFakeWebsite(site.id)}
                                  className={`flex items-center gap-2 px-3 py-2 rounded border text-[clamp(8px,0.85vw,13px)] ${selectedFakeWebsite === site.id ? 'bg-[#2d4e79] text-white' : 'bg-white/30 text-[#233f66] border-[#233f66]'}`}
                                >
                                  <span>{site.icon}</span>
                                  <span>{site.name}</span>
                                </button>
                              ))}
                            </div>
                            {selectedFakeWebsite && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)]">
                                Đã chọn: {selectedFakeWebsite}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Mã độc capcha */}
                        {(droppedGameplaySkill === 'Mã độc capcha' || droppedSkills.includes('Mã độc capcha')) && (
                          <div className="mt-[2%] flex flex-col gap-3">
                            <div className="text-[#233f66] text-[clamp(9px,0.9vw,14px)] font-semibold mb-1">
                              Mã độc capcha
                            </div>
                            {/* Submit button */}
                            <div className="w-1/3 mx-auto">
                              <button
                                type="button"
                                onClick={() => {
                                  console.log('Capcha Malware')
                                  setCapchaMalwareResult('Đã tạo mã độc capcha')
                                }}
                                className="relative w-full"
                                style={{ height: 'clamp(28px, 4vw, 40px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                              >
                                <span className="text-white text-[clamp(9px,1vw,14px)] font-bold">Kích hoạt</span>
                              </button>
                            </div>
                            {capchaMalwareResult && (
                              <div className="p-[3%] bg-white/30 rounded text-[#233f66] text-[clamp(8px,0.85vw,13px)] break-words">
                                {capchaMalwareResult}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Submit tổng - cho cả 2 skill và 3 skill */}
                        {(droppedSkills.includes('Đánh giá tên miền giả mạo') && droppedSkills.includes('Tạo website giả mạo')) && (
                          <div className="mt-[2%] w-1/3 mx-auto">
                            <button
                              type="button"
                              onClick={() => {
                                console.log('Submit Total:', { 
                                  domain: fakeDomainInput, 
                                  evaluation: domainEvaluationResult, 
                                  website: selectedFakeWebsite,
                                  capcha: droppedSkills.includes('Mã độc capcha') ? 'included' : 'not included'
                                })
                              }}
                              className="relative w-full"
                              style={{ height: 'clamp(32px, 5vw, 48px)', backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%', backgroundPosition: 'center' }}
                            >
                              <span className="text-white text-[clamp(10px,1.2vw,16px)] font-bold">Submit Tổng</span>
                            </button>
                          </div>
                        )}

                        {/* Empty drop zone hint - chỉ hiện khi chưa có skill nào */}
                        {droppedSkills.length === 0 && (
                          <div className="flex items-center justify-center h-full text-[#3f5d85] text-[clamp(10px,1.2vw,18px)] font-semibold">
                            {activeExerciseTask.id === 1 ? 'Kéo thả skill vào đây' : 'Ô kéo thả skill'}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="absolute bottom-[4.2%] left-[4.65%] right-[4.65%] flex h-[10.8%] items-center gap-[1.2%]">
                      <span className="text-[#233f66] text-[clamp(10px,1.35vw,24px)] font-extrabold">FLAG:</span>
                      <div
                        className="relative h-[86%] flex-1 bg-no-repeat"
                        style={{ backgroundImage: "url('/assets/pixel-office/button_06.png')", backgroundSize: '100% 100%' }}
                      >
                        <input
                          value={gameplayFlagInput}
                          onChange={(event) => setGameplayFlagInput(event.target.value)}
                          placeholder={`Nhập flag cho Bài ${activeExerciseTask.id}`}
                          className="h-full w-full border-0 bg-transparent px-[4%] text-[clamp(9px,1.05vw,20px)] text-[#2d4e79] outline-none"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={handleGameplaySubmit}
                        className="h-[92%] w-[22%] bg-no-repeat text-white text-[clamp(10px,1.25vw,24px)] font-bold"
                        style={{ backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%' }}
                      >
                        Submit
                      </button>
                    </div>

                  </div>

                  <div
                    className="absolute right-[0.1%] top-[0.5%] h-[98.4%] w-[24.3%] bg-no-repeat"
                    style={{ backgroundImage: "url('/assets/pixel-office/button_05.png')", backgroundSize: '100% 100%' }}
                  >
                    <div className="absolute left-[15%] right-[11.5%] top-[14.8%] bottom-[4.8%] overflow-y-auto pr-[2px]">
                      <div className="flex flex-col gap-[10px] pb-[4px]">
                        {GAMEPLAY_SKILL_OPTIONS.map((skill) => (
                          <button
                            key={skill}
                            type="button"
                            draggable
                            onDragStart={(event) => event.dataTransfer.setData('text/plain', skill)}
                            onClick={() => {
                              // Nhóm 3 skill đặc biệt: Đánh giá tên miền giả mạo, Tạo website giả mạo, Mã độc capcha
                              const isSpecialSkill = CAPCHA_SKILL_GROUP.includes(skill as typeof CAPCHA_SKILL_GROUP[number])
                              const hasSpecialSkill = droppedSkills.some(s => CAPCHA_SKILL_GROUP.includes(s as typeof CAPCHA_SKILL_GROUP[number]))
                              
                              if (isSpecialSkill) {
                                // Nếu đang có skill thường: không được thêm skill đặc biệt
                                if (droppedSkills.length > 0 && !hasSpecialSkill) {
                                  return
                                }
                                // Skill đặc biệt: thả cùng lúc được với các skill đặc biệt khác
                                if (!droppedSkills.includes(skill)) {
                                  setDroppedSkills(prev => [...prev, skill])
                                }
                              } else {
                                // Skill thường: chỉ được thả độc lập (xóa tất cả skill cũ)
                                setDroppedSkills([skill])
                                setDroppedGameplaySkill(skill)
                              }
                              // Set as main skill if first one
                              if (droppedSkills.length === 0) {
                                setDroppedGameplaySkill(skill)
                              }
                            }}
                            className="flex h-[40px] md:h-[48px] w-full shrink-0 items-center justify-center px-3 text-center bg-no-repeat text-white text-[clamp(6px,0.85vw,14px)] font-bold"
                            style={{ backgroundImage: "url('/assets/pixel-office/button_03.png')", backgroundSize: '100% 100%' }}
                          >
                            {skill}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={closeExerciseScene}
                  className="mx-auto mt-1.5 block border-0 bg-transparent p-0"
                  aria-label="Back"
                >
                  <img
                    src="/assets/pixel-office/back.png"
                    alt="Back"
                    className="h-[30px] md:h-[34px] w-auto select-none"
                    draggable={false}
                  />
                </button>
                
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex flex-col overflow-hidden h-[calc(100dvh-3.5rem)] md:h-full">
      {/* Floating photo comment DOM bubbles */}
      {floatingCommentsRef.current.map(fc => (
        <div key={fc.key} className="absolute pointer-events-none z-30 whitespace-nowrap"
          style={{
            left: 0,
            top: 0,
            opacity: fc.opacity,
            transform: `translate3d(${fc.x}px, ${fc.y}px, 0) translateX(-50%)`,
            willChange: 'transform, opacity',
          }}>
          <span className="inline-block px-3 py-1 rounded-full text-sm font-bold"
            style={{ backgroundColor: 'rgba(0,0,0,0.8)', color: '#FFD700' }}>
            {fc.text}
          </span>
        </div>
      ))}
      {/* Floating code snippets (working agents): rise to top, overlay top bar */}
      {floatingCodeRef.current.map(fc => (
        <div key={fc.key} className="absolute pointer-events-none z-40 whitespace-nowrap"
          style={{
            left: 0,
            top: 0,
            opacity: fc.opacity,
            transform: `translate3d(${fc.x}px, ${fc.y}px, 0) translateX(-50%)`,
            willChange: 'transform, opacity',
          }}>
          <span
            className="inline-block px-2 py-0.5 rounded-md text-sm font-mono font-semibold"
            style={{
              backgroundColor: fc.kind === 'sre' ? 'rgba(28,6,6,0.9)' : 'rgba(0,0,0,0.72)',
              color: fc.kind === 'sre' ? '#DC2626' : '#4ade80',
              border: fc.kind === 'sre' ? '1px solid rgba(127,29,29,0.85)' : '1px solid transparent',
            }}
          >
            {fc.text}
          </span>
        </div>
      ))}
      {/* Top bar: agent tags + controls */}
      <div className="flex flex-col gap-2 p-3 md:p-4 border-b border-[var(--border)]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-10 ">
            <span className="text-sm font-bold text-[var(--text)]">{t('pixelOffice.title')}</span>
            <button onClick={() => { unlockAudio(); playHacSound(); }}
              className="w-8 h-8 rounded-lg border border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--card)] transition-colors flex items-center justify-center cursor-pointer"
              title="Phát âm thanh"
            >
              <img src="/assets/pixel-office/loudspeaker.png" alt="Loa" className="w-5 h-5 object-contain" />
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={toggleSound}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                isEditMode ? 'bg-[var(--accent)]/10 border-[var(--accent)]/30 text-[var(--accent)]'
                  : 'bg-[var(--card)] border-[var(--border)] text-[var(--text-muted)]'
              }`}>
              {isEditMode ? t('pixelOffice.exitEdit') : t('pixelOffice.editMode')}
            </button>
          </div>
        </div>
        <div className="md:hidden overflow-x-auto pb-1">
          {displayAgents.length === 0 ? (
            <div className="text-[var(--text-muted)] text-sm">{t('common.noData')}</div>
          ) : (
            <div className="flex gap-2 min-w-full snap-x snap-mandatory">
              {mobileAgentPages.map((page, pageIndex) => (
                <div key={`mobile-agent-page-${pageIndex}`} className="grid grid-cols-3 grid-rows-3 gap-2 min-w-full h-[8.4rem] shrink-0 snap-start">
                  {page.map((agent) => renderAgentChip(agent, true))}
                  {page.length < 9 && Array.from({ length: 9 - page.length }).map((_, i) => (
                    <div key={`mobile-agent-page-${pageIndex}-placeholder-${i}`} className="rounded-lg border border-transparent" />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="hidden md:flex gap-2 flex-1 flex-wrap">
          {displayAgents.map((agent) => renderAgentChip(agent))}
          {displayAgents.length === 0 && (
            <div className="text-[var(--text-muted)] text-sm">{t('common.noData')}</div>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden bg-[#1a1a2e]">
        <canvas ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onContextMenu={handleContextMenu}
          className="w-full h-full"
          style={{ touchAction: 'none' }} />
        {!officeReady && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#1a1a2e]/85 pointer-events-none">
            <div className="px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm text-[var(--text-muted)]">
              {t('common.loading')}
            </div>
          </div>
        )}

        {/* Broadcast notifications */}
        {broadcasts.length > 0 && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex flex-col gap-2 pointer-events-none">
            {broadcasts.map(b => (
              <div key={b.id} className="px-4 py-2 rounded-full bg-black/70 text-white text-sm font-medium backdrop-blur-sm shadow-lg whitespace-nowrap"
                style={{ animation: 'broadcastIn 0.3s ease-out, broadcastOut 0.5s ease-in 4.5s forwards' }}>
                {b.text}
              </div>
            ))}
          </div>
        )}
        <style>{`
          @keyframes broadcastIn { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes broadcastOut { from { opacity: 1; } to { opacity: 0; transform: translateY(-8px); } }
        `}</style>

        {/* Reset view button */}
        <button onClick={resetView}
          className="absolute top-3 right-3 px-2 py-1.5 text-xs rounded-lg border bg-[var(--card)]/80 border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--accent)] transition-colors backdrop-blur-sm"
          title={t('pixelOffice.resetView')}>
          ⊡
        </button>

        {/* Agent hover tooltip */}
        {hoveredInfo && !isEditMode && !selectedAgentId && !isMobileViewport && (
          <div className="absolute pointer-events-none z-10 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)]/95 backdrop-blur-sm text-xs shadow-lg"
            style={{ left: Math.min(mousePosRef.current.x + 12, (containerRef.current?.clientWidth || 300) - 180), top: mousePosRef.current.y + 12 }}>
            {hoveredInfo.kind === 'gatewaySre' ? (
              <>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span>🧯</span>
                  <span className="font-semibold text-[var(--text)]">{t('pixelOffice.gatewaySre.name')}</span>
                </div>
                <div className="space-y-0.5 text-[var(--text-muted)]">
                  <div className="flex justify-between gap-4">
                    <span>{t('pixelOffice.gatewaySre.statusLabel')}</span>
                    <span className="text-[var(--text)]">{t(`pixelOffice.gatewaySre.status.${hoveredInfo.gatewaySre.status}`)}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span>{t('pixelOffice.gatewaySre.responseMs')}</span>
                    <span className="text-[var(--text)]">{hoveredInfo.gatewaySre.responseMs != null ? `${hoveredInfo.gatewaySre.responseMs}ms` : '--'}</span>
                  </div>
                  {hoveredInfo.gatewaySre.error && (
                    <div className="text-red-300">{hoveredInfo.gatewaySre.error}</div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span>{hoveredInfo.agent?.emoji}</span>
                  <span className="font-semibold text-[var(--text)]">{hoveredInfo.isSubagent ? t('pixelOffice.tempWorker') : hoveredInfo.agent?.name}</span>
                </div>
                {hoveredInfo.isSubagent ? (
                  <div className="text-[var(--text-muted)]">
                    {(hoveredInfo.parentAgentId || 'unknown')} {t('pixelOffice.tempWorker.createdBy')}
                  </div>
                ) : (
                  <div className="space-y-0.5 text-[var(--text-muted)]">
                    <div className="flex justify-between gap-4"><span>{t('agent.sessionCount')}</span><span className="text-[var(--text)]">{hoveredInfo.stats?.sessionCount ?? '--'}</span></div>
                    <div className="flex justify-between gap-4"><span>{t('agent.messageCount')}</span><span className="text-[var(--text)]">{hoveredInfo.stats?.messageCount ?? '--'}</span></div>
                    <div className="flex justify-between gap-4"><span>{t('agent.tokenUsage')}</span><span className="text-[var(--text)]">{hoveredInfo.stats ? formatTokens(hoveredInfo.stats.totalTokens) : '--'}</span></div>
                    <div className="flex justify-between gap-4"><span>{t('agent.todayAvgResponse')}</span><span className="text-[var(--text)]">{hoveredInfo.stats?.todayAvgResponseMs ? `${(hoveredInfo.stats.todayAvgResponseMs / 1000).toFixed(1)}s` : '--'}</span></div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Server click tooltip */}
        {serverTooltip.open && !isEditMode && !selectedAgentId && (() => {
          const snapshot = gatewaySreRef.current
          const status = snapshot.status === 'healthy' || snapshot.status === 'degraded' || snapshot.status === 'down'
            ? snapshot.status
            : 'unknown'
          const statusColor =
            status === 'healthy' ? 'text-green-400'
            : status === 'degraded' ? 'text-yellow-400'
            : status === 'down' ? 'text-red-400'
            : 'text-[var(--text-muted)]'
          const tooltipLeft = Math.max(8, Math.min(serverTooltip.x + 12, (containerRef.current?.clientWidth || 300) - (isMobileViewport ? 220 : 200)))
          const tooltipTop = Math.max(8, serverTooltip.y + 12)
          return (
            <div
              className="absolute pointer-events-auto z-10 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)]/95 backdrop-blur-sm text-xs shadow-lg"
              style={{ left: tooltipLeft, top: tooltipTop }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="absolute right-1.5 top-1.5 text-[10px] leading-none text-[var(--text-muted)] hover:text-[var(--text)]"
                onClick={() => setServerTooltip((prev) => ({ ...prev, open: false }))}
                aria-label={t('common.close')}
                title={t('common.close')}
              >
                ×
              </button>
              <div className="flex items-center gap-1.5 mb-1.5">
                <span>🖥️</span>
                <span className="font-semibold text-[var(--text)]">Gateway Server</span>
              </div>
              <div className="space-y-0.5 text-[var(--text-muted)]">
                <div className="flex justify-between gap-4">
                  <span>{t('pixelOffice.gatewaySre.statusLabel')}</span>
                  <span className={statusColor}>{t(`pixelOffice.serverStatus.${status}`)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>{t('pixelOffice.gatewaySre.responseMs')}</span>
                  <span className="text-[var(--text)]">{snapshot.responseMs != null ? `${snapshot.responseMs}ms` : '--'}</span>
                </div>
                {snapshot.error && (
                  <div className="text-red-300">{snapshot.error}</div>
                )}
              </div>
            </div>
          )
        })()}

        {/* Agent detail card (click) */}
        {selectedAgentId && !isEditMode && (() => {
          const runtimeAgent = agents.find(a => a.agentId === selectedAgentId)
          const configAgent = configAgentsRef.current.get(selectedAgentId)
          const stats = agentStatsRef.current.get(selectedAgentId) ?? configAgent?.session
          const displayState = runtimeAgent?.state || 'offline'
          const gw = gatewayRef.current

          if (!runtimeAgent && !configAgent) return null

          const cardAgent: AgentCardAgent = {
            id: selectedAgentId,
            name: configAgent?.name || runtimeAgent?.name || selectedAgentId,
            emoji: configAgent?.emoji || runtimeAgent?.emoji || '🤖',
            model: configAgent?.model || '',
            platforms: configAgent?.platforms || [],
            session: stats
              ? {
                  lastActive: stats.lastActive,
                  totalTokens: stats.totalTokens,
                  contextTokens: 0,
                  sessionCount: stats.sessionCount,
                  todayAvgResponseMs: stats.todayAvgResponseMs,
                  messageCount: stats.messageCount,
                  weeklyResponseMs: stats.weeklyResponseMs,
                  weeklyTokens: stats.weeklyTokens,
                }
              : undefined,
          }

          return (
            <div
              className={modalOverlayClass}
              onClick={() => {
                if (isMobileViewport && performance.now() - selectedAgentOpenedAtRef.current < 280) return
                setSelectedAgentId(null)
              }}
            >
              <div className={modalPanelClass("w-[24rem]", "max-h-[78%]")} onClick={e => e.stopPropagation()}>
                <div className="flex justify-end mb-2">
                  <button onClick={() => setSelectedAgentId(null)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-lg leading-none">×</button>
                </div>
                <AgentCard
                  agent={cardAgent}
                  gatewayPort={gw.port}
                  gatewayToken={gw.token}
                  gatewayHost={gw.host}
                  t={t}
                  testResult={cachedModelTestResults?.[selectedAgentId]}
                  platformTestResults={cachedPlatformTestResults || undefined}
                  sessionTestResult={cachedSessionTestResults?.[selectedAgentId]}
                  agentState={displayState}
                  dmSessionResults={cachedDmSessionResults || undefined}
                  providerAccessModeMap={providerAccessModeRef.current}
                />
              </div>
            </div>
          )
        })()}

        {/* Mobile subagent creator tooltip */}
        {subagentCreatorInfo && !isEditMode && isMobileViewport && (() => {
          const tooltipLeft = Math.max(8, Math.min(subagentCreatorInfo.x + 12, (containerRef.current?.clientWidth || 300) - 220))
          const tooltipTop = Math.max(8, subagentCreatorInfo.y + 12)
          return (
            <div
              className="absolute pointer-events-auto z-10 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)]/95 backdrop-blur-sm text-xs shadow-lg"
              style={{ left: tooltipLeft, top: tooltipTop }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="absolute right-1.5 top-1.5 text-[10px] leading-none text-[var(--text-muted)] hover:text-[var(--text)]"
                onClick={() => setSubagentCreatorInfo(null)}
                aria-label={t('common.close')}
                title={t('common.close')}
              >
                ×
              </button>
              <div className="flex items-center gap-1.5 mb-1.5">
                <span>🧑‍🔧</span>
                <span className="font-semibold text-[var(--text)]">{t('pixelOffice.tempWorker.source')}</span>
              </div>
              <div className="space-y-0.5 text-[var(--text-muted)]">
                <div>{subagentCreatorInfo.parentAgentId} {t('pixelOffice.tempWorker.createdBy')}</div>
              </div>
            </div>
          )
        })()}

        {/* Model panel (bookshelf click) */}
        {showModelPanel && !isEditMode && (
          <div
            className={modalOverlayClass}
            onClick={() => {
              if (isMobileViewport && performance.now() - modelPanelOpenedAtRef.current < 280) return
              setShowModelPanel(false)
            }}
          >
            <div className={modalPanelClass("w-80")} onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <span className="font-semibold text-[var(--text)]">📚 {t('models.title')}</span>
                <button onClick={() => setShowModelPanel(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-lg leading-none">×</button>
              </div>
              {providersRef.current.length === 0 ? (
                <div className="text-xs text-[var(--text-muted)]">{t('common.noData')}</div>
              ) : (
                <div className="space-y-3">
                  {providersRef.current.map(provider => (
                    <div key={provider.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2.5">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-semibold text-[var(--accent)]">{provider.id}</span>
                        {provider.usedBy.length > 0 && (
                          <div className="flex gap-1">
                            {provider.usedBy.map(a => (
                              <span key={a.id} className="text-sm" title={a.name}>{a.emoji}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="space-y-1">
                        {provider.models.map(model => (
                          <div key={model.id} className="flex items-center justify-between text-xs">
                            <span className="text-[var(--text)] truncate mr-2">🧠 {model.name || model.id}</span>
                            {model.contextWindow && <span className="text-[var(--text-muted)] whitespace-nowrap">{formatTokens(model.contextWindow)}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Token ranking panel (whiteboard click) */}
        {showTokenRank && !isEditMode && (() => {
          const ranked = agents
            .map(a => ({ ...a, tokens: agentStatsRef.current.get(a.agentId)?.totalTokens || 0 }))
            .sort((a, b) => b.tokens - a.tokens)
          const maxTokens = ranked[0]?.tokens || 1
          const handleCloseTokenRankOverlay = () => {
            // Prevent the opening tap from immediately closing the modal on mobile.
            if (isMobileViewport && performance.now() - tokenRankOpenedAtRef.current < 280) return
            setShowTokenRank(false)
          }
          return (
            <div className={modalOverlayClass} onClick={handleCloseTokenRankOverlay}>
              <div className={modalPanelClass("w-80", "max-h-[78%]")} onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-[var(--text)]">📊 {t('agent.tokenUsage')}</span>
                  <button onClick={() => setShowTokenRank(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-lg leading-none">×</button>
                </div>
                {ranked.length === 0 ? (
                  <div className="text-xs text-[var(--text-muted)]">{t('common.noData')}</div>
                ) : (
                  <div className="space-y-2">
                    {ranked.map((a, i) => (
                      <div key={a.agentId}>
                        <div className="flex items-center justify-between text-xs mb-0.5">
                          <span className="flex items-center gap-1.5">
                            <span className="text-[var(--text-muted)] w-4">{i + 1}.</span>
                            <span>{a.emoji}</span>
                            <span className="text-[var(--text)]">{a.name}</span>
                          </span>
                          <span className="text-[var(--text)] font-mono">{formatTokens(a.tokens)}</span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-[var(--bg)] overflow-hidden">
                          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${(a.tokens / maxTokens) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* Activity heatmap panel (clock click) */}
        {showActivityHeatmap && !isEditMode && (() => {
          const agentGrids = activityHeatmapRef.current
          const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
          const hourLabels = [0, 3, 6, 9, 12, 15, 18, 21]
          const cellSize = 14
          const gap = 2
          const leftPad = 36
          const topPad = 20
          const colors = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353']
          const svgW = leftPad + 24 * (cellSize + gap)
          const svgH = topPad + 7 * (cellSize + gap)
          return (
            <div className={modalOverlayClass} onClick={() => setShowActivityHeatmap(false)}>
              <div className={modalPanelClass("w-fit max-w-[94vw]", "max-h-[85%]")} onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-[var(--text)]">🕐 {t('pixelOffice.heatmap.title')}</span>
                  <button onClick={() => setShowActivityHeatmap(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-lg leading-none">×</button>
                </div>
                {!agentGrids ? (
                  <div className="text-xs text-[var(--text-muted)] py-8 text-center">{t('common.loading')}</div>
                ) : agentGrids.length === 0 ? (
                  <div className="text-xs text-[var(--text-muted)] py-8 text-center">{t('common.noData')}</div>
                ) : (
                  <div className="space-y-4">
                    {agentGrids.map(({ agentId, grid }) => {
                      const agent = agents.find(a => a.agentId === agentId)
                      let maxVal = 1
                      for (const row of grid) for (const v of row) if (v > maxVal) maxVal = v
                      return (
                        <div key={agentId}>
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <span>{agent?.emoji || '🤖'}</span>
                            <span className="text-xs font-semibold text-[var(--text)]">{agent?.name || agentId}</span>
                          </div>
                          <div className="overflow-x-auto">
                            <svg width={svgW} height={svgH} className="block min-w-max">
                              {hourLabels.map(h => (
                                <text key={h} x={leftPad + h * (cellSize + gap) + cellSize / 2} y={topPad - 6} textAnchor="middle" fontSize={9} fill="var(--text-muted)">{h}</text>
                              ))}
                              {dayLabels.map((label, d) => (
                                <text key={d} x={leftPad - 4} y={topPad + d * (cellSize + gap) + cellSize / 2 + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">{label}</text>
                              ))}
                              {grid.map((row, d) => row.map((v, h) => {
                                const level = v === 0 ? 0 : Math.min(4, Math.ceil((v / maxVal) * 4))
                                return (
                                  <rect key={`${d}-${h}`} x={leftPad + h * (cellSize + gap)} y={topPad + d * (cellSize + gap)}
                                    width={cellSize} height={cellSize} rx={2} fill={colors[level]} opacity={0.9}>
                                    <title>{`${dayLabels[d]} ${h}:00 — ${v} ${t('pixelOffice.heatmap.messages')}`}</title>
                                  </rect>
                                )
                              }))}
                            </svg>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* Phone panel — version info */}
        {showPhonePanel && !isEditMode && (() => {
          const info = versionInfo
          return (
            <div className={modalOverlayClass} onClick={() => setShowPhonePanel(false)}>
              <div className={modalPanelClass("w-80")} onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-[var(--text)]">📱 OpenClaw Latest</span>
                  <button onClick={() => setShowPhonePanel(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-lg leading-none">×</button>
                </div>
                {!info && versionLoading ? (
                  <div className="text-xs text-[var(--text-muted)] py-8 text-center">{t('common.loading')}</div>
                ) : !info && versionLoadFailed ? (
                  <div className="text-xs text-[var(--text-muted)] py-8 text-center">{t('common.loadError')}</div>
                ) : !info ? (
                  <div className="text-xs text-[var(--text-muted)] py-8 text-center">{t('common.noData')}</div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold text-[var(--accent)]">{info.name}</span>
                      <span className="text-xs text-[var(--text-muted)]">{new Date(info.publishedAt).toLocaleDateString()}</span>
                    </div>
                    <div className="text-xs text-[var(--text)] whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">{info.body}</div>
                    <a href={info.htmlUrl} target="_blank" rel="noopener noreferrer"
                      className="block text-center text-xs text-[var(--accent)] hover:underline">
                      View on GitHub →
                    </a>
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* Idle rank panel (sofa click) */}
        {showIdleRank && !isEditMode && (() => {
          const rankData = idleRankRef.current
          const ranked = rankData
            ? [...rankData].sort((a, b) => b.idlePercent - a.idlePercent).map(r => {
                const agent = agents.find(a => a.agentId === r.agentId)
                return { ...r, emoji: agent?.emoji || '🤖', name: agent?.name || r.agentId }
              })
            : null
          return (
            <div className={modalOverlayClass} onClick={() => setShowIdleRank(false)}>
              <div className={modalPanelClass("w-80")} onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-[var(--text)]">🛋️ {t('pixelOffice.idleRank.title')}</span>
                  <button onClick={() => setShowIdleRank(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-lg leading-none">×</button>
                </div>
                {!ranked || ranked.length === 0 ? (
                  <div className="text-xs text-[var(--text-muted)] py-8 text-center">{t('common.noData')}</div>
                ) : (
                  <div className="space-y-2.5">
                    {ranked.map((a, i) => {
                      const barColor = a.idlePercent >= 60 ? '#4ade80' : a.idlePercent >= 30 ? '#f59e0b' : '#f87171'
                      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
                      return (
                        <div key={a.agentId}>
                          <div className="flex items-center justify-between text-xs mb-0.5">
                            <span className="flex items-center gap-1.5">
                              <span className="w-5 text-center">{medal}</span>
                              <span>{a.emoji}</span>
                              <span className="text-[var(--text)]">{a.name}</span>
                            </span>
                            <span className="font-mono font-semibold" style={{ color: barColor }}>{a.idlePercent}%</span>
                          </div>
                          <div className="w-full h-2 rounded-full bg-[var(--bg)] overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${a.idlePercent}%`, backgroundColor: barColor }} />
                          </div>
                          <div className="flex gap-3 text-[10px] text-[var(--text-muted)] mt-0.5">
                            <span>{t('pixelOffice.idleRank.online')} {a.onlineMinutes}m</span>
                            <span>{t('pixelOffice.idleRank.active')} {a.activeMinutes}m</span>
                            <span>{t('pixelOffice.idleRank.idle')} {a.idleMinutes}m</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* Fullscreen photograph viewer */}
        {fullscreenPhoto && photographRef.current && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 cursor-pointer"
            onClick={() => {
              if (isMobileViewport && performance.now() - fullscreenPhotoOpenedAtRef.current < 280) return
              setFullscreenPhoto(false)
            }}
          >
            <img src={photographRef.current.src} alt="photograph" className="max-w-[90%] max-h-[90%] object-contain rounded-lg shadow-2xl" />
            <button onClick={() => setFullscreenPhoto(false)} className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl leading-none">×</button>
          </div>
        )}

        {/* Editor overlays */}
        {isEditMode && (
          <>
            <EditActionBar
              isDirty={editor.isDirty}
              canUndo={editor.undoStack.length > 0}
              canRedo={editor.redoStack.length > 0}
              onUndo={handleUndo} onRedo={handleRedo}
              onSave={handleSave} onReset={handleReset} />
            <EditorToolbar
              activeTool={editor.activeTool}
              selectedTileType={editor.selectedTileType}
              selectedFurnitureType={editor.selectedFurnitureType}
              selectedFurnitureUid={editor.selectedFurnitureUid}
              selectedFurnitureColor={selectedItem?.color ?? null}
              floorColor={editor.floorColor}
              wallColor={editor.wallColor}
              onToolChange={handleToolChange}
              onTileTypeChange={handleTileTypeChange}
              onFloorColorChange={handleFloorColorChange}
              onWallColorChange={handleWallColorChange}
              onSelectedFurnitureColorChange={handleSelectedFurnitureColorChange}
              onFurnitureTypeChange={handleFurnitureTypeChange}
              onDeleteFurniture={() => {
                const office = officeRef.current
                const editor = editorRef.current
                if (!office || !editor.selectedFurnitureUid) return
                applyEdit(removeFurniture(office.layout, editor.selectedFurnitureUid))
                editor.clearSelection()
                forceEditorUpdate()
              }} />
          </>
        )}
      </div>
    </div>
  )
}
