-- Init used by the pi2d end-to-end harness.
-- Minimal, hermetic: only the plugin under test on the runtimepath, with the
-- web console enabled and diagnostics enabled. Setting up the plugin here also
-- makes `pi.host` skip its own `setup()` call.
local plugin = vim.env.PI2_E2E_PLUGIN or "/home/yuez/Workspace/Neovim/pi2.nvim-web"
vim.opt.runtimepath:prepend(plugin)
vim.opt.swapfile = false
vim.opt.shadafile = "NONE"
vim.g.mapleader = " "

require("pi").setup({
    web = { enabled = true, log = true, auto_start = false },
})
