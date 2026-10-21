import {
    Activity,
    Ban,
    Boxes,
    Check,
    ChevronDown,
    ChevronRight,
    Circle,
    Clock,
    Copy,
    Cpu,
    Eye,
    File,
    Folder,
    GitBranch,
    Globe,
    HardDrive,
    Laptop,
    LayoutGrid,
    ListTodo,
    MemoryStick,
    MessageSquare,
    Monitor,
    Moon,
    MoreHorizontal,
    Pencil,
    Play,
    Plug,
    Plus,
    QrCode,
    RefreshCw,
    ScanLine,
    Search,
    Send,
    Server,
    Settings,
    Smartphone,
    Square,
    Sun,
    Tablet,
    Terminal,
    Trash2,
    TriangleAlert,
    X,
    Zap,
} from "lucide-react";
import type { ComponentType } from "react";

export type IconName =
    | "logo"
    | "server"
    | "plus"
    | "scan"
    | "qr"
    | "folder"
    | "chat"
    | "status"
    | "search"
    | "chevron-down"
    | "chevron-right"
    | "send"
    | "stop"
    | "x"
    | "check"
    | "alert"
    | "clock"
    | "cpu"
    | "mem"
    | "disk"
    | "model"
    | "phone"
    | "laptop"
    | "tablet"
    | "copy"
    | "revoke"
    | "refresh"
    | "play"
    | "terminal"
    | "todo"
    | "branch"
    | "eye"
    | "edit"
    | "trash"
    | "more"
    | "settings"
    | "sun"
    | "moon"
    | "monitor"
    | "dot"
    | "globe"
    | "plug"
    | "file"
    | "zap";

type IconComponent = ComponentType<{ size?: number | string; strokeWidth?: number; className?: string; "aria-hidden"?: boolean }>;

/** 1:1 name map for the prototype's `App.icon(name)` (Lucide, 24 viewBox, stroke 1.75). */
const ICONS: Record<IconName, IconComponent> = {
    logo: LayoutGrid,
    server: Server,
    plus: Plus,
    scan: ScanLine,
    qr: QrCode,
    folder: Folder,
    chat: MessageSquare,
    status: Activity,
    search: Search,
    "chevron-down": ChevronDown,
    "chevron-right": ChevronRight,
    send: Send,
    stop: Square,
    x: X,
    check: Check,
    alert: TriangleAlert,
    clock: Clock,
    cpu: Cpu,
    mem: MemoryStick,
    disk: HardDrive,
    model: Boxes,
    phone: Smartphone,
    laptop: Laptop,
    tablet: Tablet,
    copy: Copy,
    revoke: Ban,
    refresh: RefreshCw,
    play: Play,
    terminal: Terminal,
    todo: ListTodo,
    branch: GitBranch,
    eye: Eye,
    edit: Pencil,
    trash: Trash2,
    more: MoreHorizontal,
    settings: Settings,
    sun: Sun,
    moon: Moon,
    monitor: Monitor,
    dot: Circle,
    globe: Globe,
    plug: Plug,
    file: File,
    zap: Zap,
};

export interface IconProps {
    name: IconName;
    size?: number;
    strokeWidth?: number;
    className?: string;
}

export function Icon({ name, size = 16, strokeWidth = 1.75, className }: IconProps) {
    const Component = ICONS[name] ?? Circle;
    return <Component size={size} strokeWidth={strokeWidth} className={className} aria-hidden={true} />;
}
