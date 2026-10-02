/**
 * Icon set. Tool icons come from the tool registry (inline SVG data URLs), the
 * rest of the chrome uses this small hand-drawn path library so the app has no
 * icon-font dependency and stays fully offline.
 */
import type { SVGProps } from 'react'

export type IconName =
  | 'new' | 'open' | 'save' | 'export' | 'print' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste'
  | 'delete' | 'duplicate' | 'group' | 'ungroup' | 'align-left' | 'align-center' | 'align-right'
  | 'align-top' | 'align-middle' | 'align-bottom' | 'distribute-h' | 'distribute-v'
  | 'zoom-in' | 'zoom-out' | 'zoom-fit' | 'grid' | 'guides' | 'ruler' | 'wireframe' | 'eye'
  | 'eye-off' | 'lock' | 'unlock' | 'plus' | 'minus' | 'chevron' | 'close' | 'check' | 'search'
  | 'sun' | 'moon' | 'home' | 'layers' | 'palette' | 'effects' | 'pages' | 'history' | 'text'
  | 'brush' | 'photo' | 'mask' | 'lens' | 'wrench' | 'wand' | 'upload' | 'download' | 'cloud'
  | 'drag' | 'node' | 'path' | 'ring' | 'swap' | 'swap-y' | 'shape' | 'pen' | 'grid-paper'
  | 'refresh' | 'install' | 'info' | 'warning' | 'separations' | 'imposition' | 'marks'
  | 'comment' | 'users' | 'share' | 'link' | 'bell' | 'pin'

const PATHS: Record<IconName, string> = {
  new: 'M6 2h8l4 4v16H6zM13 2v5h5',
  open: 'M3 6h6l2 2h10v11H3z',
  save: 'M4 3h12l4 4v14H4zM8 3v6h8V3M8 15h8v6H8z',
  export: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  print: 'M7 8V3h10v5M5 8h14v8h-3v5H8v-5H5z',
  undo: 'M9 7H5V3M5 7a9 9 0 1 1-1 9',
  redo: 'M15 7h4V3M19 7a9 9 0 1 0 1 9',
  cut: 'M5 5l14 14M19 5L5 19M6 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M18 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  copy: 'M9 9h11v11H9zM4 15V4h11',
  paste: 'M9 4h6v3H9zM6 5H4v16h16V5h-2',
  delete: 'M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14',
  duplicate: 'M4 4h11v11H4zM9 9h11v11H9z',
  group: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  ungroup: 'M3 3h7v7H3zM14 14h7v7h-7zM12 3h3M3 12v3M9 21h3M21 9v3',
  'align-left': 'M3 3v18M7 7h9v4H7zM7 14h13v4H7z',
  'align-center': 'M12 3v18M6 7h12v4H6zM4 14h16v4H4z',
  'align-right': 'M21 3v18M8 7h9v4H8zM4 14h13v4H4z',
  'align-top': 'M3 3h18M7 7h4v9H7zM14 7h4v13h-4z',
  'align-middle': 'M3 12h18M7 6h4v12H7zM14 4h4v16h-4z',
  'align-bottom': 'M3 21h18M7 8h4v9H7zM14 4h4v13h-4z',
  'distribute-h': 'M3 3v18M21 3v18M9 7h6v10H9z',
  'distribute-v': 'M3 3h18M3 21h18M7 9v6h10V9z',
  'zoom-in': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4M11 8v6M8 11h6',
  'zoom-out': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4M8 11h6',
  'zoom-fit': 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  grid: 'M3 9h18M3 15h18M9 3v18M15 3v18',
  guides: 'M3 8h18M3 16h18M8 3v18M16 3v18',
  ruler: 'M3 8h18v8H3zM7 8v3M11 8v4M15 8v3M19 8v4',
  wireframe: 'M4 4h16v16H4zM4 4l16 16M20 4L4 20M12 4v16M4 12h16',
  eye: 'M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  'eye-off': 'M3 3l18 18M10.6 6.2A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.6 7.3C3.9 9 2 12 2 12s4 6 10 6c1.2 0 2.3-.2 3.3-.6',
  lock: 'M6 11h12v10H6zM9 11V7a3 3 0 0 1 6 0v4',
  unlock: 'M6 11h12v10H6zM9 11V7a3 3 0 0 1 5.9-.7',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  chevron: 'M8 10l4 4 4-4',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  home: 'M3 11l9-8 9 8M6 10v11h12V10',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  palette: 'M12 3a9 9 0 0 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a4 4 0 0 0 4-4 9 9 0 0 0-9-6M8 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2M13 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2',
  effects: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  pages: 'M6 3h9l4 4v12H6zM15 3v4h4M3 7v14h12',
  history: 'M12 7v5l4 2M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  text: 'M5 5h14M12 5v14M9 19h6',
  brush: 'M4 20c3 0 5-1 6-3 1-1.7 1-3 .5-4L18 5.5a2 2 0 0 0-3-3L7.5 10C6.5 10 4 10.5 4 14c0 2 0 4 0 6z',
  photo: 'M3 5h18v14H3zM8 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M4 17l5-5 4 4 3-3 4 4',
  mask: 'M12 3a9 9 0 1 0 9 9h-9zM12 12V3',
  lens: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  wrench: 'M14 7a4 4 0 1 0 5 5l-9 9-3-3z',
  wand: 'M6 18L18 6M15 3v3M20 8h-3M18.5 12.5l1.5 1.5M12 5l1.5 1.5',
  upload: 'M12 21V9M7 14l5-5 5 5M4 4h16',
  download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  cloud: 'M6 19a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.6-1.6A4 4 0 0 1 18 19z',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  node: 'M6 6h.01M18 6h.01M6 18h.01M18 18h.01M6 6l12 12M18 6L6 18',
  path: 'M4 18c4 0 4-12 8-12s4 12 8 12',
  ring: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  swap: 'M4 8h13l-3-3M20 16H7l3 3',
  'swap-y': 'M8 4v13l-3-3M16 20V7l3 3',
  shape: 'M4 6h10l6 6-6 6H4z',
  pen: 'M12 3l7 7-9 9-5 1 1-5zM14 5l5 5',
  'grid-paper': 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  comment: 'M4 4h16v11H9l-5 5zM8 8h8M8 11h5',
  users: 'M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16.5 11a3 3 0 1 0 0-6M17 14c2.8 0 5 2.2 5 5',
  share: 'M12 3v11M8 7l4-4 4 4M5 14v6h14v-6',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  bell: 'M6 9a6 6 0 1 1 12 0v5l2 3H4l2-3zM10 20a2 2 0 0 0 4 0',
  pin: 'M12 22s7-9 7-13a7 7 0 1 0-14 0c0 4 7 13 7 13M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4',
  install: 'M12 3v10M8 9l4 4 4-4M5 17v3h14v-3',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8h.01M11 12h1v5h1',
  warning: 'M12 3l9 17H3zM12 9v5M12 17h.01',
  separations: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7zM8 15h8',
  imposition: 'M3 3h18v18H3zM12 3v18M3 12h18',
  marks: 'M3 3h4v4H3zM17 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4zM7 5h10M5 7v10M19 7v10M7 19h10',
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={name}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" data-icon="CorelByDre">
      <defs>
        <linearGradient id="cbd-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#19c2b8" />
          <stop offset="1" stopColor="#0c6f6a" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="url(#cbd-mark)" />
      <path d="M9 22c3.6 0 4.4-5 6.6-5S18 22 22.5 22" fill="none" stroke="#04191a" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="22.5" cy="11" r="3" fill="#f7f9fb" />
    </svg>
  )
}
