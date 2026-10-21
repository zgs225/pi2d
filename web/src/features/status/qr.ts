/**
 * Port of the prototype's `App.drawQR`: a deterministic fake QR derived from a
 * seed string. Colors come from the design tokens only, so a theme switch
 * redraws the same pattern with the dark surfaces.
 */
export function drawQr(canvas: HTMLCanvasElement, seed: string): void {
    let context: CanvasRenderingContext2D | null = null;
    try {
        context = canvas.getContext("2d");
    } catch {
        return;
    }
    if (!context) return;

    const n = 25;
    const cell = 8;
    canvas.width = n * cell;
    canvas.height = n * cell;

    const styles = getComputedStyle(document.documentElement);
    const cardColor = styles.getPropertyValue("--card").trim() || "transparent";
    const foregroundColor = styles.getPropertyValue("--foreground").trim() || "currentColor";

    context.fillStyle = cardColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = foregroundColor;

    let state = 0;
    for (const char of seed) state = (state * 31 + char.charCodeAt(0)) >>> 0;
    const random = () => {
        state = (state * 1103515245 + 12345) >>> 0;
        return state / 4294967296;
    };

    const finder = (x: number, y: number) => {
        context?.fillRect(x * cell, y * cell, 7 * cell, 7 * cell);
        context?.clearRect((x + 1) * cell, (y + 1) * cell, 5 * cell, 5 * cell);
        context?.fillRect((x + 2) * cell, (y + 2) * cell, 3 * cell, 3 * cell);
        if (context) context.fillStyle = foregroundColor;
    };

    for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
            const inFinder = (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
            if (!inFinder && random() > 0.52) context.fillRect(x * cell, y * cell, cell, cell);
        }
    }

    finder(0, 0);
    finder(n - 7, 0);
    finder(0, n - 7);
}
