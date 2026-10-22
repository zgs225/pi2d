-- Init used by the pi2 daemon end-to-end harness.
-- Minimal, hermetic: only the plugin under test on the runtimepath, with the
-- web console enabled and diagnostics enabled. Setting up the plugin here also
-- makes `pi.host` skip its own `setup()` call.
--
-- `cli.args` reaches every `pi --mode rpc` process the plugin spawns, so the
-- test-only attention extension (`scripts/e2e/attention-ext.ts`) is present in
-- the session the daemon drives (docs/e2e.md A11 — pre-execution diff review
-- needs something that emits `extension_ui_request`).
local function here()
    local source = debug.getinfo(1, "S").source
    if source:sub(1, 1) == "@" then
        source = source:sub(2)
    end
    return vim.fn.fnamemodify(source, ":p:h")
end

local plugin = vim.env.PI2_E2E_PLUGIN or "/home/yuez/Workspace/Neovim/pi2.nvim-web"
local attention_ext = here() .. "/attention-ext.ts"
assert(vim.fn.filereadable(attention_ext) == 1, "e2e attention extension missing: " .. attention_ext)

vim.opt.runtimepath:prepend(plugin)
vim.opt.swapfile = false
vim.opt.shadafile = "NONE"
vim.g.mapleader = " "

require("pi").setup({
    web = { enabled = true, log = true, auto_start = false },
    cli = { args = { "--extension", attention_ext } },
})
