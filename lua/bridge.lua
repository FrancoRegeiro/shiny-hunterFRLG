-- mGBA Lua Bridge — TCP server for remote control from Node.js
-- Load this script in mGBA: Tools → Scripting → Load Script

local PORT = 8888
local LOG_PATH = "./logs/lua-bridge.log"
local server = nil
local client = nil
local buffer = ""
local pendingCommand = nil
local holdFrames = 0
local heldKeys = {}

-- File logger — writes to logs/lua-bridge.log so Node can tail it
local logFile = io.open(LOG_PATH, "a")

local function log(level, msg)
  local timestamp = os.date("%Y-%m-%d %H:%M:%S")
  local line = timestamp .. " [" .. level .. "] " .. msg
  console:log(line)
  if logFile then
    logFile:write(line .. "\n")
    logFile:flush()
  end
end

local function logError(msg)
  local timestamp = os.date("%Y-%m-%d %H:%M:%S")
  local line = timestamp .. " [ERROR] " .. msg
  console:error(line)
  if logFile then
    logFile:write(line .. "\n")
    logFile:flush()
  end
end

-- Button name → mGBA key constant mapping
local KEY_MAP = {
  A = C.GBA_KEY.A,
  B = C.GBA_KEY.B,
  START = C.GBA_KEY.START,
  SELECT = C.GBA_KEY.SELECT,
  UP = C.GBA_KEY.UP,
  DOWN = C.GBA_KEY.DOWN,
  LEFT = C.GBA_KEY.LEFT,
  RIGHT = C.GBA_KEY.RIGHT,
  L = C.GBA_KEY.L,
  R = C.GBA_KEY.R
}

-- Simple JSON parser for our limited command set
local function parseJSON(str)
  str = str:match("^%s*(.-)%s*$")
  if not str or str == "" then return nil end

  local result = {}

  local cmd = str:match('"cmd"%s*:%s*"([^"]*)"')
  if cmd then result.cmd = cmd end

  local slot = str:match('"slot"%s*:%s*(%d+)')
  if slot then result.slot = tonumber(slot) end

  local frames = str:match('"frames"%s*:%s*(%d+)')
  if frames then result.frames = tonumber(frames) end

  local enabled = str:match('"enabled"%s*:%s*(%a+)')
  if enabled then result.enabled = (enabled == "true") end

  local path = str:match('"path"%s*:%s*"([^"]*)"')
  if path then result.path = path end

  local message = str:match('"message"%s*:%s*"([^"]*)"')
  if message then result.message = message end

  local address = str:match('"address"%s*:%s*(%d+)')
  if address then result.address = tonumber(address) end

  local size = str:match('"size"%s*:%s*(%d+)')
  if size then result.size = tonumber(size) end

  local keysStr = str:match('"keys"%s*:%s*%[([^%]]*)%]')
  if keysStr then
    result.keys = {}
    for key in keysStr:gmatch('"([^"]*)"') do
      table.insert(result.keys, key)
    end
  end

  return result
end

local function sendResponse(resp)
  if client then
    local json = '{"status":"' .. (resp.status or "ok") .. '"'
    if resp.frame then json = json .. ',"frame":' .. resp.frame end
    if resp.message then json = json .. ',"message":"' .. resp.message .. '"' end
    json = json .. '}\n'
    client:send(json)
  end
end

local function handleCommand(cmd)
  if not cmd or not cmd.cmd then
    logError("Invalid command received")
    sendResponse({ status = "error", message = "invalid command" })
    return
  end

  local frame = emu:currentFrame()

  if cmd.cmd == "press" then
    local keyNames = {}
    heldKeys = {}
    if cmd.keys then
      for _, keyName in ipairs(cmd.keys) do
        local key = KEY_MAP[keyName]
        if key then
          table.insert(heldKeys, key)
          table.insert(keyNames, keyName)
          emu:addKey(key)
        else
          logError("Unknown key: " .. keyName)
        end
      end
    end
    holdFrames = cmd.frames or 3
    log("INFO", "press [" .. table.concat(keyNames, ",") .. "] for " .. holdFrames .. " frames (frame " .. frame .. ")")
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "release" then
    for _, key in ipairs(heldKeys) do
      emu:clearKey(key)
    end
    heldKeys = {}
    holdFrames = 0
    log("INFO", "release all keys (frame " .. frame .. ")")
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "loadState" then
    local slot = cmd.slot or 1
    emu:loadStateSlot(slot)
    log("INFO", "loadState slot " .. slot .. " (frame " .. frame .. ")")
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "saveState" then
    local slot = cmd.slot or 1
    emu:saveStateSlot(slot)
    log("INFO", "saveState slot " .. slot .. " (frame " .. frame .. ")")
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "turbo" then
    -- Try multiple mGBA APIs for fast-forward (varies by version)
    local ok = false
    local err_msg = ""

    -- Try emu:setFastForwardRatio (newer mGBA)
    if not ok and emu.setFastForwardRatio then
      local s, e = pcall(function()
        if cmd.enabled then
          emu:setFastForwardRatio(0)  -- 0 = uncapped
        else
          emu:setFastForwardRatio(1)
        end
      end)
      if s then ok = true else err_msg = tostring(e) end
    end

    -- Try emu:setFrameLimit
    if not ok and emu.setFrameLimit then
      local s, e = pcall(function()
        if cmd.enabled then
          emu:setFrameLimit(0)
        else
          emu:setFrameLimit(1)
        end
      end)
      if s then ok = true else err_msg = tostring(e) end
    end

    if ok then
      log("INFO", "turbo " .. (cmd.enabled and "ON" or "OFF") .. " (frame " .. frame .. ")")
      sendResponse({ status = "ok", frame = frame })
    else
      log("WARN", "turbo not supported by this mGBA version: " .. err_msg)
      sendResponse({ status = "error", message = "turbo not supported" })
    end

  elseif cmd.cmd == "screenshot" then
    local path = cmd.path or "/tmp/shiny-hunter-frame.png"
    emu:screenshot(path)
    log("INFO", "screenshot → " .. path .. " (frame " .. frame .. ")")
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "reset" then
    log("INFO", "Soft reset (frame " .. frame .. ")")
    -- Send response BEFORE reset, since emu:reset() may disrupt the socket
    sendResponse({ status = "ok", frame = frame })
    emu:reset()

  elseif cmd.cmd == "readMemory" then
    local addr = cmd.address or 0
    local size = cmd.size or 4
    local values = {}
    for i = 0, size - 1 do
      table.insert(values, emu:read8(addr + i))
    end
    -- Build a hex string of the bytes
    local hex = ""
    for _, v in ipairs(values) do
      hex = hex .. string.format("%02X", v)
    end
    -- Also build a 32-bit or 16-bit value (little-endian)
    local value = 0
    for i = 1, math.min(size, 4) do
      value = value + values[i] * (256 ^ (i - 1))
    end
    log("INFO", "readMemory 0x" .. string.format("%08X", addr) .. " size=" .. size .. " hex=" .. hex .. " value=" .. value)
    -- Send response with hex and numeric value
    if client then
      local json = '{"status":"ok","frame":' .. frame .. ',"hex":"' .. hex .. '","value":' .. value .. '}\n'
      client:send(json)
    end
    return

  elseif cmd.cmd == "log" then
    local msg = cmd.message or "no message"
    log("INFO", "[ENCOUNTER] " .. msg .. " (frame " .. frame .. ")")
    sendResponse({ status = "ok", frame = frame })

  else
    logError("Unknown command: " .. tostring(cmd.cmd))
    sendResponse({ status = "error", message = "unknown command: " .. tostring(cmd.cmd) })
  end
end

-- Process incoming TCP data
local function processBuffer()
  while true do
    local lineEnd = buffer:find("\n")
    if not lineEnd then break end

    local line = buffer:sub(1, lineEnd - 1)
    buffer = buffer:sub(lineEnd + 1)

    if line ~= "" then
      local cmd = parseJSON(line)
      handleCommand(cmd)
    end
  end
end

-- Per-frame callback
local function onFrame()
  -- Handle held keys countdown
  if holdFrames > 0 then
    holdFrames = holdFrames - 1
    if holdFrames == 0 then
      for _, key in ipairs(heldKeys) do
        emu:clearKey(key)
      end
      heldKeys = {}
    end
  end

  -- Accept new connections
  if server then
    local newClient = server:accept()
    if newClient then
      if client then
        pcall(function() client:close() end)
      end
      client = newClient
      -- Ensure non-blocking mode (critical: prevents frame callback from stalling)
      if client.settimeout then
        client:settimeout(0)
      end
      buffer = ""
      log("INFO", "Client connected")
    end
  end

  -- Read data from client
  if client then
    local data, err = client:receive(1024)
    if data then
      buffer = buffer .. data
      processBuffer()
    elseif err and (err == "closed" or err == "reset") then
      log("INFO", "Client disconnected (" .. tostring(err) .. ")")
      client = nil
      buffer = ""
    end
    -- nil with "timeout" or no error = no data available yet, keep connection alive
  end
end

-- Initialize TCP server
server = socket.bind("127.0.0.1", PORT)
if server then
  server:listen()
  log("INFO", "Listening on port " .. PORT)
else
  logError("Failed to bind to port " .. PORT)
end

-- Register frame callback
callbacks:add("frame", onFrame)
log("INFO", "mGBA Lua bridge loaded")
