-- mGBA Lua Bridge — TCP server for remote control from Node.js
-- Load this script in mGBA: Tools → Scripting → Load Script

local PORT = 8888
local server = nil
local client = nil
local buffer = ""
local pendingCommand = nil
local holdFrames = 0
local heldKeys = {}

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
  -- Remove whitespace
  str = str:match("^%s*(.-)%s*$")
  if not str or str == "" then return nil end

  local result = {}

  -- Extract cmd
  local cmd = str:match('"cmd"%s*:%s*"([^"]*)"')
  if cmd then result.cmd = cmd end

  -- Extract slot (number)
  local slot = str:match('"slot"%s*:%s*(%d+)')
  if slot then result.slot = tonumber(slot) end

  -- Extract frames (number)
  local frames = str:match('"frames"%s*:%s*(%d+)')
  if frames then result.frames = tonumber(frames) end

  -- Extract enabled (boolean)
  local enabled = str:match('"enabled"%s*:%s*(%a+)')
  if enabled then result.enabled = (enabled == "true") end

  -- Extract path (string)
  local path = str:match('"path"%s*:%s*"([^"]*)"')
  if path then result.path = path end

  -- Extract keys (array of strings)
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
    sendResponse({ status = "error", message = "invalid command" })
    return
  end

  local frame = emu:currentFrame()

  if cmd.cmd == "press" then
    -- Press specified keys for N frames
    heldKeys = {}
    if cmd.keys then
      for _, keyName in ipairs(cmd.keys) do
        local key = KEY_MAP[keyName]
        if key then
          table.insert(heldKeys, key)
          emu:addKey(key)
        end
      end
    end
    holdFrames = cmd.frames or 3
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "release" then
    for _, key in ipairs(heldKeys) do
      emu:clearKey(key)
    end
    heldKeys = {}
    holdFrames = 0
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "loadState" then
    local slot = cmd.slot or 1
    emu:loadStateSlot(slot)
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "saveState" then
    local slot = cmd.slot or 1
    emu:saveStateSlot(slot)
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "turbo" then
    local speed = 1
    if cmd.enabled then speed = 0 end  -- 0 = uncapped (turbo)
    emu:setFrameLimit(speed)
    sendResponse({ status = "ok", frame = frame })

  elseif cmd.cmd == "screenshot" then
    local path = cmd.path or "/tmp/shiny-hunter-frame.png"
    emu:screenshot(path)
    sendResponse({ status = "ok", frame = frame })

  else
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
      if client then client:close() end
      client = newClient
      client:nodelay(true)
      buffer = ""
      console:log("Bridge: client connected")
    end
  end

  -- Read data from client
  if client then
    local data, err = client:receive(1024)
    if data then
      buffer = buffer .. data
      processBuffer()
    elseif err then
      -- Connection closed
      console:log("Bridge: client disconnected")
      client = nil
      buffer = ""
    end
  end
end

-- Initialize TCP server
server = socket.bind("127.0.0.1", PORT)
if server then
  server:listen()
  console:log("Bridge: listening on port " .. PORT)
else
  console:error("Bridge: failed to bind to port " .. PORT)
end

-- Register frame callback
callbacks:add("frame", onFrame)
console:log("Bridge: mGBA Lua bridge loaded")
