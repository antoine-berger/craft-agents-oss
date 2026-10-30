/** Classic status glyphs and colors verified against the installed Conductor 0.92.0. */
import { forwardRef } from 'react'
import { createLucideIcon, type LucideIcon, type LucideProps } from 'lucide-react'
import type { PrIconState } from './chat-header/pr-watch/pr-watch-state'

const OpenIcon = createLucideIcon("conductor-open", [
  ["circle", {"cx": "18", "cy": "18", "r": "3", "key": "0"}],
  ["circle", {"cx": "6", "cy": "6", "r": "3", "key": "1"}],
  ["path", {"d": "M13 6h3a2 2 0 0 1 2 2v7", "key": "2"}],
  ["line", {"x1": "6", "x2": "6", "y1": "9", "y2": "21", "key": "3"}],
])

const DraftIcon = createLucideIcon("conductor-draft", [
  ["circle", {"cx": "18", "cy": "18", "r": "3", "key": "0"}],
  ["circle", {"cx": "6", "cy": "6", "r": "3", "key": "1"}],
  ["path", {"d": "M18 6V5", "key": "2"}],
  ["path", {"d": "M18 11v-1", "key": "3"}],
  ["line", {"x1": "6", "x2": "6", "y1": "9", "y2": "21", "key": "4"}],
])

const MergedIcon = createLucideIcon("conductor-merged", [
  ["circle", {"cx": "18", "cy": "18", "r": "3", "key": "0"}],
  ["circle", {"cx": "6", "cy": "6", "r": "3", "key": "1"}],
  ["path", {"d": "M6 21V9a9 9 0 0 0 9 9", "key": "2"}],
])

const QueuedIconBase = createLucideIcon("conductor-queued", [
  ["path", {"d": "M3.75 4.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5ZM3 7.75a.75.75 0 0 1 1.5 0v2.878a2.251 2.251 0 1 1-1.5 0Zm.75 5.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm5-7.75a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm5.75 2.5a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-1.5 0a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z", "key": "0"}],
])
const QueuedIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <QueuedIconBase viewBox="0 0 16 16" fill="currentColor" stroke="none" {...props} ref={ref} />
))

const ReadyIcon = createLucideIcon("conductor-ready", [
  ["circle", {"cx": "5", "cy": "6", "r": "3", "key": "0"}],
  ["path", {"d": "M5 9v12", "key": "1"}],
  ["circle", {"cx": "19", "cy": "18", "r": "3", "key": "2"}],
  ["path", {"d": "m15 9-3-3 3-3", "key": "3"}],
  ["path", {"d": "M12 6h5a2 2 0 0 1 2 2v7", "key": "4"}],
])

const ConflictingIcon = createLucideIcon("conductor-conflicting", [
  ["path", {"d": "M12 6h4a2 2 0 0 1 2 2v7", "key": "0"}],
  ["path", {"d": "M6 12v9", "key": "1"}],
  ["path", {"d": "M9 3 3 9", "key": "2"}],
  ["path", {"d": "M9 9 3 3", "key": "3"}],
  ["circle", {"cx": "18", "cy": "18", "r": "3", "key": "4"}],
])

const ChecksFailingIcon = createLucideIcon("conductor-checks-failing", [
  ["path", {"d": "M18 6 6 18", "key": "0"}],
  ["path", {"d": "m6 6 12 12", "key": "1"}],
])

const BranchIcon = createLucideIcon("conductor-branch", [
  ["path", {"d": "M15 6a9 9 0 0 0-9 9V3", "key": "0"}],
  ["circle", {"cx": "18", "cy": "6", "r": "3", "key": "1"}],
  ["circle", {"cx": "6", "cy": "18", "r": "3", "key": "2"}],
])

const LocalIcon = createLucideIcon("conductor-local", [
  ["path", {"d": "M10 16h.01", "key": "0"}],
  ["path", {"d": "M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z", "key": "1"}],
  ["path", {"d": "M21.946 12.013H2.054", "key": "2"}],
  ["path", {"d": "M6 16h.01", "key": "3"}],
])

const UnstartedIcon = createLucideIcon("conductor-unstarted", [
  ["circle", {"cx": "12", "cy": "12", "r": "9", "key": "0"}],
])

const FailedIcon = createLucideIcon("conductor-failed", [
  ["circle", {"cx": "12", "cy": "12", "r": "10", "key": "0"}],
  ["line", {"x1": "12", "x2": "12", "y1": "8", "y2": "12", "key": "1"}],
  ["line", {"x1": "12", "x2": "12.01", "y1": "16", "y2": "16", "key": "2"}],
])

export const STATUS_COLOR = {
  neutral: 'text-[#14100f99] dark:text-[#ffffff99]',
  failed: 'text-[#dc2828] dark:text-[#f87272]',
  merged: 'text-purple-500',
  queued: 'text-[#e0bb00] dark:text-[#ffdc2e]',
  ready: 'text-[#16a249] dark:text-[#4ade80]',
  conflicting: 'text-[#cca694] dark:text-[#ddc1b1]',
} as const

export const PR_STATUS_ICON: Record<PrIconState, LucideIcon> = {
  "open": OpenIcon,
  "draft": DraftIcon,
  "merged": MergedIcon,
  "queued": QueuedIcon,
  "ready": ReadyIcon,
  "conflicting": ConflictingIcon,
  "checks-failing": ChecksFailingIcon,
  closed: BranchIcon,
}

export const PR_STATUS_COLOR: Record<PrIconState, string> = {
  "open": STATUS_COLOR.neutral,
  "draft": STATUS_COLOR.neutral,
  "merged": STATUS_COLOR.merged,
  "queued": STATUS_COLOR.queued,
  "ready": STATUS_COLOR.ready,
  "conflicting": STATUS_COLOR.conflicting,
  "checks-failing": STATUS_COLOR.failed,
  closed: STATUS_COLOR.neutral,
}

export const SESSION_STATUS_ICON = {
  "branch": BranchIcon,
  "local": LocalIcon,
  "unstarted": UnstartedIcon,
  "failed": FailedIcon,
} as const
