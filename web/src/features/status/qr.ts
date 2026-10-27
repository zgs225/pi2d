/**
 * Renders the daemon's real QR matrix (`pairCode.qr.rows`, one `"0"`/`"1"`
 * string per row) into a square canvas.
 *
 * 渲染要点：
 *  - `rows` 已是去掉静区的模块矩阵，渲染器自己负责留白和颜色；
 *  - 按 devicePixelRatio 放大位图（避免糊），CSS 宽度自适应容器且最多 200px；
 *  - 颜色只取 token：前景 `--foreground`、底色 `--card`，主题切换后重绘；
 *  - `rows` 为空或不是方阵时清空画布（不画任何占位图）。
 */

/** Upper bound of the CSS square; the container may be narrower. */
export const QR_MAX_CSS_SIZE = 200;
/** Quiet zone in modules, drawn on the card background. */
const QUIET_MODULES = 3;

function cssSize(canvas: HTMLCanvasElement): number {
    const parent = canvas.parentElement;
    const available = parent?.clientWidth || canvas.clientWidth || QR_MAX_CSS_SIZE;
    return Math.max(0, Math.min(QR_MAX_CSS_SIZE, available));
}

function isMatrix(rows: string[]): boolean {
    const size = rows.length;
    if (!size) return false;
    return rows.every((row) => typeof row === "string" && row.length === size && /^[01]+$/.test(row));
}

export function drawQr(canvas: HTMLCanvasElement, rows: string[]): void {
    let context: CanvasRenderingContext2D | null = null;
    try {
        context = canvas.getContext("2d");
    } catch {
        return;
    }
    if (!context) return;

    // 空矩阵：清掉上一张码，不留伪图案。
    if (!isMatrix(rows)) {
        canvas.width = 0;
        canvas.height = 0;
        context.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }

    const size = rows.length;
    const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const css = Math.round(cssSize(canvas)) || QR_MAX_CSS_SIZE;
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);

    const styles = getComputedStyle(document.documentElement);
    const cardColor = styles.getPropertyValue("--card").trim() || "transparent";
    const foregroundColor = styles.getPropertyValue("--foreground").trim() || "currentColor";

    // 静区 + 模块网格都按 devicePixelRatio 缩放，保持正方形。
    const total = size + QUIET_MODULES * 2;
    const module = canvas.width / total;

    context.fillStyle = cardColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = foregroundColor;

    for (let y = 0; y < size; y += 1) {
        const row = rows[y] ?? "";
        for (let x = 0; x < size; x += 1) {
            if (row[x] !== "1") continue;
            // 取整像素边界，避免相邻模块间的缝。
            const left = Math.round((x + QUIET_MODULES) * module);
            const top = Math.round((y + QUIET_MODULES) * module);
            const right = Math.round((x + QUIET_MODULES + 1) * module);
            const bottom = Math.round((y + QUIET_MODULES + 1) * module);
            context.fillRect(left, top, right - left, bottom - top);
        }
    }
}
