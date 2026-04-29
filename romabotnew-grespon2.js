const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const fs = require('fs')
const axios = require('axios')
const readline = require('readline')

// ══ CONFIG ══
const ownerNumbers = ['6285716075774', '99772543287335']
const BOT_NAME = 'RomaAi'

// ══ Suppress Baileys verbose logs ══
const _origWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, enc, cb) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString()
    const noise = ['Closing open session','Closing session:','SessionEntry','chainKey:',
        'ephemeralKeyPair','lastRemoteEphemeralKey','currentRatchet','pendingPreKey',
        'remoteIdentityKey','registrationId','indexInfo','baseKeyType','preKeyId','<Buffer ','BTXrJc']
    if (noise.some(n => s.includes(n))) { if (cb) cb(); return true }
    return _origWrite(chunk, enc, cb)
}
process.on('uncaughtException', e => console.log('[Error]', e.message))

// ══ Admin cache ══
const adminCache = {}
function updateAdminCache(gid, participants) {
    adminCache[gid] = new Set(participants.filter(p => p.admin).map(p => p.id))
}

// ══ AI Config — Multi Gemini Key, auto-rotate ══
if (!fs.existsSync('./ai_config.json')) fs.writeFileSync('./ai_config.json', '{}')
let _aiConfig = {}
try { _aiConfig = JSON.parse(fs.readFileSync('./ai_config.json', 'utf8')) } catch(e) {}

let _geminiKeys = []
if (_aiConfig.geminiKeys && Array.isArray(_aiConfig.geminiKeys)) {
    _geminiKeys = _aiConfig.geminiKeys.filter(k => k && k.length > 10)
} else if (_aiConfig.geminiKey) {
    _geminiKeys = [_aiConfig.geminiKey]
}
// Default key
if (_geminiKeys.length === 0) _geminiKeys = ['AIzaSyC8uDPfZOU2dxdIuzk95oWOhDa_U7ppWhw']

let _geminiKeyIdx = _aiConfig.keyIdx || 0
if (_geminiKeyIdx >= _geminiKeys.length) _geminiKeyIdx = 0

function _saveAiConfig() {
    try {
        _aiConfig.geminiKeys = _geminiKeys
        _aiConfig.keyIdx = _geminiKeyIdx
        fs.writeFileSync('./ai_config.json', JSON.stringify(_aiConfig, null, 2))
    } catch(e) {}
}

// ══ System Prompt ══
const _DEFAULT_SYSTEM_PROMPT = `WAJIB: Selalu jawab dalam Bahasa Indonesia, apapun bahasanya pertanyaan yang masuk. Jawab seperti orang asli yang lagi ngobrol santai. Jangan kaku, jangan terlalu formal, dan jangan terdengar seperti robot. Pakai bahasa sehari-hari yang enak dibaca. Boleh sedikit ekspresif, tapi jangan berlebihan. Hindari struktur jawaban yang terlalu rapi seperti poin-poin resmi. Fokus ke penjelasan yang terasa natural dan mengalir.`

let _aiSystemPrompt = null
try {
    const _pc = JSON.parse(fs.readFileSync('./ai_prompt.json', 'utf8'))
    _aiSystemPrompt = _pc.prompt || null
} catch(e) {}

// Kata kunci pertanyaan tentang siapa yang buat AI ini
const _CREATOR_KEYWORDS = [
    'kamu siapa','siapa kamu','kamu dibuat siapa','dibuat siapa','siapa yang buat',
    'siapa pembuatmu','siapa penciptamu','diciptakan siapa','kamu itu apa',
    'lo siapa','lu siapa','kamu apa','bot ini siapa','who made you','who created you',
    'who are you','what are you','siapa yg buat','siapa yg bikin','siapa pembuat',
    'kamu buatan siapa','buatan siapa','dikembangkan siapa','siapa developermu',
    'siapa yang bikin','kamu asisten apa','ini bot apa','bot apa ini'
]

function _isCreatorQuestion(text) {
    const t = text.toLowerCase()
    return _CREATOR_KEYWORDS.some(kw => t.includes(kw))
}

function _buildQuery(q) {
    // Kalau pertanyaan tentang siapa yang buat → jawab langsung tanpa kirim ke Gemini
    // (ditangani di level handler, bukan di sini)
    const sysPrompt = _aiSystemPrompt || _DEFAULT_SYSTEM_PROMPT
    return `[INSTRUKSI SISTEM - ikuti selalu]: ${sysPrompt}\n\n[PERTANYAAN USER]: ${q}`
}

// ══ Conversation History — per sender, max 10 pesan terakhir ══
if (!fs.existsSync('./ai_history.json')) fs.writeFileSync('./ai_history.json', '{}')
let _aiHistory = {}
try { _aiHistory = JSON.parse(fs.readFileSync('./ai_history.json', 'utf8')) } catch(e) {}
const MAX_HISTORY = 10  // simpan 10 turn terakhir per user

function _getHistory(num) {
    return _aiHistory[num] || []
}
function _addHistory(num, role, text) {
    if (!_aiHistory[num]) _aiHistory[num] = []
    _aiHistory[num].push({ role, content: text })
    // Trim jika terlalu panjang
    if (_aiHistory[num].length > MAX_HISTORY * 2) {
        _aiHistory[num] = _aiHistory[num].slice(-MAX_HISTORY * 2)
    }
    try { fs.writeFileSync('./ai_history.json', JSON.stringify(_aiHistory, null, 2)) } catch(e) {}
}
function _clearHistory(num) {
    _aiHistory[num] = []
    try { fs.writeFileSync('./ai_history.json', JSON.stringify(_aiHistory, null, 2)) } catch(e) {}
}

// ══ AI Limit — 20x / 45 menit per user, owner unlimited ══
if (!fs.existsSync('./ai_limit.json')) fs.writeFileSync('./ai_limit.json', '{}')
let _aiLimitData = {}
try { _aiLimitData = JSON.parse(fs.readFileSync('./ai_limit.json', 'utf8')) } catch(e) {}
const AI_LIMIT_MAX = 20
const AI_LIMIT_WINDOW = 45 * 60 * 1000

function _saveAiLimit() {
    try { fs.writeFileSync('./ai_limit.json', JSON.stringify(_aiLimitData, null, 2)) } catch(e) {}
}
function checkAiLimit(num) {
    if (!_aiLimitData[num]) _aiLimitData[num] = { times: [], bonus: 0, unlimited: false }
    const d = _aiLimitData[num]
    if (d.unlimited) return { ok: true, unlimited: true }
    const now = Date.now()
    d.times = d.times.filter(t => now - t < AI_LIMIT_WINDOW)
    const max = AI_LIMIT_MAX + (d.bonus || 0)
    if (d.times.length >= max) {
        const tunggu = Math.ceil((AI_LIMIT_WINDOW - (now - d.times[0])) / 60000)
        return { ok: false, tunggu, sisa: 0 }
    }
    d.times.push(now)
    _saveAiLimit()
    return { ok: true, sisa: max - d.times.length }
}
function getAiLimitInfo(num) {
    if (!_aiLimitData[num]) _aiLimitData[num] = { times: [], bonus: 0, unlimited: false }
    const d = _aiLimitData[num]
    if (d.unlimited) return { unlimited: true }
    const now = Date.now()
    d.times = d.times.filter(t => now - t < AI_LIMIT_WINDOW)
    const max = AI_LIMIT_MAX + (d.bonus || 0)
    const sisa = max - d.times.length
    let tunggu = 0
    if (d.times.length > 0) tunggu = Math.ceil((AI_LIMIT_WINDOW - (now - d.times[0])) / 60000)
    return { sisa: Math.max(0, sisa), max, tunggu, habis: sisa <= 0 }
}
function addAiBonus(num, jml) {
    if (!_aiLimitData[num]) _aiLimitData[num] = { times: [], bonus: 0, unlimited: false }
    _aiLimitData[num].bonus = (_aiLimitData[num].bonus || 0) + jml
    _saveAiLimit()
}
function setAiUnlimited(num, val) {
    if (!_aiLimitData[num]) _aiLimitData[num] = { times: [], bonus: 0, unlimited: false }
    _aiLimitData[num].unlimited = val
    _saveAiLimit()
}
function resetAiLimit(num) {
    if (!_aiLimitData[num]) _aiLimitData[num] = { times: [], bonus: 0, unlimited: false }
    _aiLimitData[num].unlimited = false
    _aiLimitData[num].bonus = 0
    _saveAiLimit()
}

// ══ Banned list ══
if (!fs.existsSync('./ai_banned.json')) fs.writeFileSync('./ai_banned.json', '[]')
let _aiBanned = []
try { _aiBanned = JSON.parse(fs.readFileSync('./ai_banned.json', 'utf8')) } catch(e) {}
function _saveBanned() { try { fs.writeFileSync('./ai_banned.json', JSON.stringify(_aiBanned, null, 2)) } catch(e) {} }

// ══ AI System toggle per grup ══
// { groupId: 'on'/'off' } — default 'on' di semua tempat
function _isAiOn(groupId) {
    if (!groupId) return true  // DM selalu on
    const st = _aiConfig.aiGroups && _aiConfig.aiGroups[groupId]
    if (st === 'off') return false
    return true  // default on
}
function _setAiGroup(groupId, val) {
    if (!_aiConfig.aiGroups) _aiConfig.aiGroups = {}
    _aiConfig.aiGroups[groupId] = val
    _saveAiConfig()
}

// ══ Processing tracker — anti double reply ══
const _processing = new Set()
const _processedIds = new Map()

// ══ CORE: askAI — Gemini only, multi-key rotate, retry 3x per key ══
async function askAI(query, userId, history = []) {
    const finalQuery = _buildQuery(query)

    const validKeys = _geminiKeys.filter(k => k && k.length > 10)
    if (validKeys.length === 0) throw new Error('Tidak ada API key Gemini. Pasang dulu dengan .sapikey [KEY]')

    const startIdx = _geminiKeyIdx
    for (let attempt = 0; attempt < validKeys.length; attempt++) {
        const idx = (startIdx + attempt) % validKeys.length
        const key = validKeys[idx]

        // Retry 3x untuk tiap key sebelum ganti key berikutnya
        for (let retry = 0; retry < 3; retry++) {
            try {
                // Bangun contents dari history + query baru
                const contents = []
                for (const h of history) {
                    contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })
                }
                contents.push({ role: 'user', parts: [{ text: finalQuery }] })

                const _gRes = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
                    { contents },
                    { timeout: 25000, headers: { 'Content-Type': 'application/json' } }
                )
                const _gText = _gRes.data?.candidates?.[0]?.content?.parts?.[0]?.text
                if (_gText && _gText.length > 2) {
                    if (_geminiKeyIdx !== idx) { _geminiKeyIdx = idx; _saveAiConfig() }
                    return _gText
                }
                console.log(`[Gemini key#${idx+1}] Response kosong, retry ${retry+1}/3`)
            } catch(e) {
                const code = e.response?.status
                const errMsg = e.response?.data?.error?.message || e.message
                console.log(`[Gemini key#${idx+1}] Error ${code}: ${errMsg} (retry ${retry+1}/3)`)

                // 429 = quota habis → langsung ganti key, jangan retry
                if (code === 429 || code === 400) break

                // Timeout / network error → tunggu sebentar lalu retry
                if (retry < 2) await new Promise(r => setTimeout(r, 1500 * (retry + 1)))
            }
        }

        // Key ini gagal, rotasi ke key berikutnya
        if (attempt < validKeys.length - 1) {
            _geminiKeyIdx = (idx + 1) % validKeys.length
            _saveAiConfig()
            console.log(`[Gemini] Pindah ke key#${_geminiKeyIdx + 1}`)
        }
    }

    throw new Error('Semua key Gemini gagal. Coba tambah key baru dengan .sapikey [KEY]')
}

// ══ Helper: kirim dengan typing indicator ══
async function sendTyping(sock, jid, text, options = {}) {
    try { await sock.sendPresenceUpdate('composing', jid) } catch(e) {}
    await new Promise(r => setTimeout(r, Math.min(1500, text.length * 15)))
    try { await sock.sendPresenceUpdate('paused', jid) } catch(e) {}
    return sock.sendMessage(jid, { text }, options)
}

// ══ Tanya pilihan terminal ══
function tanyaPilihan(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise(r => rl.question(q, ans => { rl.close(); r(ans.trim()) }))
}

// ══ MAIN BOT ══
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session_romaai')
    const { version } = await fetchLatestBaileysVersion()
    const logger = pino({ level: 'silent' }, pino.destination('/dev/null'))

    const sudahLogin = state.creds?.registered
    let usePairingCode = false, nomorBot = ''

    if (!sudahLogin) {
        console.log('\n┌──────────────────────────────┐')
        console.log('│        ROMAAI BOT            │')
        console.log('├──────────────────────────────┤')
        console.log('│  Pilih cara hubungkan WA:    │')
        console.log('│  1. Scan QR Code             │')
        console.log('│  2. Pairing Code             │')
        console.log('└──────────────────────────────┘')
        const p = await tanyaPilihan('\nPilih [1/2]: ')
        if (p === '2') {
            usePairingCode = true
            nomorBot = (await tanyaPilihan('Masukkan nomor WA (contoh: 628xxx): ')).replace(/[^0-9]/g, '')
        }
    }

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: ['RomaAI', 'Chrome', '3.0.0'],
        printQRInTerminal: !usePairingCode,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 5,
        getMessage: async () => ({ conversation: '' })
    })

    if (usePairingCode && !sudahLogin && nomorBot) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(nomorBot)
                const fmt = code.match(/.{1,4}/g)?.join('-') || code
                console.log(`\n📱 PAIRING CODE: ${fmt}`)
                console.log(`\n⏳ Masukkan kode di atas ke WhatsApp dalam 60 detik.\n`)
            } catch(e) { console.log('❌ Gagal generate pairing code:', e.message) }
        }, 6000)
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr && !usePairingCode) {
            const qrcode = require('qrcode-terminal')
            console.log('\n📥 SCAN QR CODE:')
            qrcode.generate(qr, { small: true })
        }
        if (connection === 'close') {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode
            if (code === DisconnectReason.loggedOut || code === 401) {
                console.log('❌ Bot logout (401). Hapus folder session_romaai dan jalankan ulang.')
                console.log('   Perintah: rm -rf session_romaai && node romabotnew-grespon2.js')
                process.exit(0)
            }
            if (code === 440) {
                console.log('⚠️  Stream error (440) — kemungkinan login dari device lain. Reconnect...')
            }
            const wait = (code === 428 || code === 503 || code === 440)
                ? 20000 + Math.floor(Math.random() * 15000)
                : 5000  + Math.floor(Math.random() * 5000)
            console.log(`🔄 Disconnect (${code}). Reconnect dalam ${Math.round(wait/1000)}s...`)
            setTimeout(() => startBot(), wait)
        } else if (connection === 'open') {
            console.log(`\n✅ ${BOT_NAME} ONLINE! Siap jawab semua pesan 🤖`)
            // Load admin cache
            try {
                const groups = await sock.groupFetchAllParticipating()
                for (const [id, meta] of Object.entries(groups)) updateAdminCache(id, meta.participants)
                console.log(`✅ Admin cache: ${Object.keys(groups).length} grup`)
            } catch(e) {}
        }
    })

    sock.ev.on('group-participants.update', async (anu) => {
        try {
            const meta = await sock.groupMetadata(anu.id)
            updateAdminCache(anu.id, meta.participants)
        } catch(e) {}
    })

    // ══════════════════════════════════════════════
    // MESSAGE HANDLER — inti bot AI
    // ══════════════════════════════════════════════
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0]
            if (!msg?.message) return
            if (m.type !== 'notify') return

            // Anti duplicate
            if (_processedIds.has(msg.key.id)) return
            _processedIds.set(msg.key.id, Date.now())
            if (_processedIds.size > 1000) {
                const cut = Date.now() - 300000
                for (const [k, v] of _processedIds) { if (v < cut) _processedIds.delete(k) }
            }

            // Skip noise
            const noisy = ['protocolMessage','senderKeyDistributionMessage','deviceSentMessage',
                'callLogMesssage','encryptedReactionMessage','keepInChatMessage']
            if (Object.keys(msg.message).every(t => noisy.includes(t))) return

            const from = msg.key.remoteJid
            if (!from) return
            const isGroup = from.endsWith('@g.us')

            // Ambil text
            const rawText = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                ''
            ).trim()

            // Deteksi sender
            let senderJid = isGroup ? msg.key.participant : from
            if (!senderJid && msg.key.fromMe) senderJid = from
            if (!senderJid) return
            const senderNum = senderJid.split('@')[0].replace(/[^0-9]/g, '')
            if (!senderNum) return

            // Cek owner
            const _nv = [senderNum, senderNum.replace(/^62/, '0'), senderNum.replace(/^0/, '62'), senderNum.slice(-10)]
            const isOwner = msg.key.fromMe === true ||
                ownerNumbers.some(n => _nv.some(v => v === n || v.endsWith(n) || n.endsWith(v)))

            // Skip pesan dari bot sendiri (kecuali owner pakai cmd)
            if (msg.key.fromMe && !rawText.startsWith('.')) return

            // Skip kalau kosong
            if (!rawText) return

            // ══ OWNER COMMANDS ══
            const lower = rawText.toLowerCase()

            // .sapikey [key] / .sapikey2 - .sapikey10
            const _skM = lower.match(/^\.sapikey(\d*)\s/)
            if (_skM || lower === '.sapikey' || lower.match(/^\.sapikey\d+$/)) {
                if (!isOwner) return await sendTyping(sock, from, '⚠️ Hanya owner!', { quoted: msg })
                const slot = _skM ? (parseInt(_skM[1]) || 1) : (lower.match(/^\.sapikey(\d+)$/)?.[1] ? parseInt(lower.match(/^\.sapikey(\d+)$/)[1]) : 1)
                const newKey = rawText.replace(/^\.sapikey\d*\s*/i, '').trim()
                if (!newKey || newKey.length < 10) {
                    let keyList = ''
                    _geminiKeys.forEach((k, i) => { keyList += `\n  🔑 Key ${i+1}: ${k.slice(0,8)}...${k.slice(-4)}` })
                    return await sendTyping(sock, from,
                        `🔑 *GEMINI API KEYS*\n━━━━━━━━━━━━━━━\n📋 Total: ${_geminiKeys.length}/10 key aktif${keyList || '\n  (belum ada)'}\n\n💡 Cara pasang:\n.sapikey [KEY] → key 1\n.sapikey2 [KEY] → key 2\n... sampai .sapikey10`,
                        { quoted: msg })
                }
                if (slot < 1 || slot > 10) return await sendTyping(sock, from, '⚠️ Slot key hanya 1–10.', { quoted: msg })
                // Pastikan array cukup panjang
                while (_geminiKeys.length < slot) _geminiKeys.push('')
                _geminiKeys[slot - 1] = newKey
                _geminiKeys = _geminiKeys.filter(k => k && k.length > 5)
                _geminiKeyIdx = 0
                _saveAiConfig()
                let list = ''
                _geminiKeys.forEach((k, i) => { list += `\n  🔑 Key ${i+1}: ${k.slice(0,8)}...${k.slice(-4)}` })
                return await sendTyping(sock, from,
                    `✅ *Key ${slot} Disimpan!*\n━━━━━━━━━━━━━━━\n📋 Total aktif: ${_geminiKeys.length} key${list}\n\n🔄 Otomatis rotate kalau quota habis`,
                    { quoted: msg })
            }

            // .rapikey [slot] — hapus key
            if (lower.match(/^\.rapikey\d*$/)) {
                if (!isOwner) return await sendTyping(sock, from, '⚠️ Hanya owner!', { quoted: msg })
                const slot = parseInt(lower.replace('.rapikey', '') || '1') || 1
                if (slot < 1 || slot > _geminiKeys.length) return await sendTyping(sock, from, `⚠️ Key ${slot} tidak ada.`, { quoted: msg })
                _geminiKeys.splice(slot - 1, 1)
                if (_geminiKeys.length === 0) _geminiKeys = ['AIzaSyC8uDPfZOU2dxdIuzk95oWOhDa_U7ppWhw']
                _geminiKeyIdx = 0
                _saveAiConfig()
                return await sendTyping(sock, from, `✅ Key ${slot} dihapus. Sisa: ${_geminiKeys.length} key.`, { quoted: msg })
            }

            // .cekkey — lihat semua key
            if (lower === '.cekkey') {
                if (!isOwner) return await sendTyping(sock, from, '⚠️ Hanya owner!', { quoted: msg })
                let list = ''
                _geminiKeys.forEach((k, i) => {
                    list += `\n  ${_geminiKeyIdx === i ? '▶️' : '🔑'} Key ${i+1}: ${k.slice(0,8)}...${k.slice(-4)}`
                })
                return await sendTyping(sock, from,
                    `🔑 *GEMINI API KEYS*\n━━━━━━━━━━━━━━━\n📋 Total: ${_geminiKeys.length}/10${list}\n\n▶️ = key yang sedang aktif`,
                    { quoted: msg })
            }

            // .aisystem on/off — aktif/nonaktif AI di grup
            if (lower === '.aisystem on' || lower === '.aisystem off') {
                if (!isOwner) return await sendTyping(sock, from, '⚠️ Hanya owner!', { quoted: msg })
                if (!isGroup) return await sendTyping(sock, from, '⚠️ Command ini hanya untuk grup!', { quoted: msg })
                const val = lower.includes('on') ? 'on' : 'off'
                _setAiGroup(from, val)
                return await sendTyping(sock, from,
                    val === 'on'
                        ? `✅ *${BOT_NAME} AKTIF* di grup ini!\n🤖 Semua pesan akan dijawab AI secara otomatis.`
                        : `🔴 *${BOT_NAME} NONAKTIF* di grup ini.\n💡 Ketik *.aisystem on* untuk aktifkan lagi.`,
                    { quoted: msg })
            }

            // .promt [teks] — set system prompt
            if (lower.startsWith('.promt ') || lower === '.promt') {
                if (!isOwner) return await sendTyping(sock, from, '⚠️ Hanya owner!', { quoted: msg })
                const p = rawText.slice(7).trim()
                if (!p) return await sendTyping(sock, from,
                    `📝 *Prompt aktif:*\n${_aiSystemPrompt || '(tidak ada, mode normal)'}\n\nUntuk ganti:\n.promt [instruksi baru]`,
                    { quoted: msg })
                _aiSystemPrompt = p
                try { fs.writeFileSync('./ai_prompt.json', JSON.stringify({ prompt: p }, null, 2)) } catch(e) {}
                return await sendTyping(sock, from, `✅ Prompt diset!\n📝 _${p}_`, { quoted: msg })
            }

            // .unpromt — reset prompt
            if (lower === '.unpromt') {
                if (!isOwner) return await sendTyping(sock, from, '⚠️ Hanya owner!', { quoted: msg })
                _aiSystemPrompt = null
                try { fs.writeFileSync('./ai_prompt.json', '{}') } catch(e) {}
                return await sendTyping(sock, from, '✅ Prompt direset ke normal.', { quoted: msg })
            }

            // .glimit [jumlah] — owner reply pesan user, tambah limit
            if (isOwner && lower.match(/^\.glimit\s+\d+$/)) {
                const jml = parseInt(rawText.split(/\s+/)[1])
                const ctx = msg.message.extendedTextMessage?.contextInfo
                if (!ctx?.participant) return await sendTyping(sock, from, '⚠️ Reply pesan user dulu!', { quoted: msg })
                const target = ctx.participant.split('@')[0].replace(/[^0-9]/g, '')
                addAiBonus(target, jml)
                const info = getAiLimitInfo(target)
                return await sendTyping(sock, from,
                    `✅ Limit @${target} +${jml}x\n📊 Total sekarang: ${info.max}x/45mnt`,
                    { mentions: [ctx.participant], quoted: msg })
            }

            // .glimitu — owner set unlimited ke user (reply)
            if (isOwner && lower === '.glimitu') {
                const ctx = msg.message.extendedTextMessage?.contextInfo
                if (!ctx?.participant) return await sendTyping(sock, from, '⚠️ Reply pesan user dulu!', { quoted: msg })
                const target = ctx.participant.split('@')[0].replace(/[^0-9]/g, '')
                setAiUnlimited(target, true)
                return await sendTyping(sock, from, `♾️ @${target} sekarang unlimited!`, { mentions: [ctx.participant], quoted: msg })
            }

            // .glimitl — owner reset limit user (reply)
            if (isOwner && lower === '.glimitl') {
                const ctx = msg.message.extendedTextMessage?.contextInfo
                if (!ctx?.participant) return await sendTyping(sock, from, '⚠️ Reply pesan user dulu!', { quoted: msg })
                const target = ctx.participant.split('@')[0].replace(/[^0-9]/g, '')
                resetAiLimit(target)
                return await sendTyping(sock, from, `🔄 Limit @${target} direset ke normal (${AI_LIMIT_MAX}x/45mnt).`, { mentions: [ctx.participant], quoted: msg })
            }

            // .grespon — kasih emoji reaksi ke pesan di channel/saluran WA
            // Format: .grespon <link_channel> <emoji> <jumlah 1-50>
            if (isOwner && lower.startsWith('.grespon')) {
                const _grParts = body.trim().split(/\s+/)
                // _grParts[0] = .grespon, [1] = link, [2] = emoji, [3] = jumlah
                const _grLink  = _grParts[1] || ''
                const _grEmoji = _grParts[2] || ''
                const _grCount = parseInt(_grParts[3]) || 0

                // Validasi input
                if (!_grLink || !_grLink.includes('whatsapp.com/channel/')) {
                    return await sendTyping(sock, from, '⚠️ *Format salah!*\n\nContoh:\n*.grespon https://whatsapp.com/channel/xxx ❤ 5*\n\nLink harus link saluran WhatsApp.', { quoted: msg })
                }
                if (!_grEmoji) {
                    return await sendTyping(sock, from, '⚠️ Emoji tidak boleh kosong!\n\nContoh: *.grespon <link> ❤ 5*', { quoted: msg })
                }
                if (_grCount < 1 || _grCount > 50) {
                    return await sendTyping(sock, from, '⚠️ Jumlah harus antara *1–50*!', { quoted: msg })
                }

                // Extract newsletter ID dari link
                // Format: https://whatsapp.com/channel/NEWSLETTER_ID
                const _grNewsletterMatch = _grLink.match(/channel\/([A-Za-z0-9]+)/)
                if (!_grNewsletterMatch) {
                    return await sendTyping(sock, from, '⚠️ Link saluran tidak valid!\n\nPastikan formatnya:\nhttps://whatsapp.com/channel/xxxxx', { quoted: msg })
                }
                const _grNewsletterId = _grNewsletterMatch[1] + '@newsletter'

                await sendTyping(sock, from, `⏳ Memulai reaksi *${_grEmoji}* sebanyak *${_grCount}x*...\n🔗 Saluran: ${_grLink}`, { quoted: msg })

                let _grSuccess = 0
                let _grFail = 0

                try {
                    // Ambil pesan terbaru dari newsletter
                    const _grMsgs = await sock.fetchMessagesFromNewsletter(_grNewsletterId, _grCount).catch(() => null)

                    if (!_grMsgs || _grMsgs.length === 0) {
                        return await sendTyping(sock, from, '❌ Gagal ambil pesan dari saluran. Pastikan:\n1. Link benar\n2. Saluran masih aktif\n3. Bot sudah follow saluran itu', { quoted: msg })
                    }

                    // Kirim reaksi ke tiap pesan (maksimal _grCount)
                    const _grTargetMsgs = _grMsgs.slice(0, _grCount)
                    for (const _grM of _grTargetMsgs) {
                        try {
                            await sock.sendMessage(_grNewsletterId, {
                                react: {
                                    text: _grEmoji,
                                    key: _grM.key
                                }
                            })
                            _grSuccess++
                            // Delay kecil biar ga keblokir WA
                            await new Promise(r => setTimeout(r, 500 + Math.random() * 500))
                        } catch (_grErr) {
                            _grFail++
                        }
                    }
                } catch (_grMainErr) {
                    return await sendTyping(sock, from,
                        `❌ Error: ${_grMainErr.message || 'Gagal konek ke saluran'}`,
                        { quoted: msg }
                    )
                }

                return await sendTyping(sock, from,
                    `✅ *GRESPON SELESAI!*\n━━━━━━━━━━━━━━━\n${_grEmoji} Emoji: *${_grEmoji}*\n✅ Berhasil: *${_grSuccess}x*\n❌ Gagal: *${_grFail}x*\n🔗 Saluran: ${_grLink}`,
                    { quoted: msg }
                )
            }

            // .ban — owner ban user dari bot (reply)
            if (isOwner && lower === '.ban') {
                const ctx = msg.message.extendedTextMessage?.contextInfo
                if (!ctx?.participant) return await sendTyping(sock, from, '⚠️ Reply pesan user dulu!', { quoted: msg })
                const target = ctx.participant.split('@')[0].replace(/[^0-9]/g, '')
                if (!_aiBanned.includes(target)) { _aiBanned.push(target); _saveBanned() }
                return await sendTyping(sock, from, `🚫 @${target} di-ban dari bot.`, { mentions: [ctx.participant], quoted: msg })
            }

            // .unban — owner unban user (reply)
            if (isOwner && lower === '.unban') {
                const ctx = msg.message.extendedTextMessage?.contextInfo
                if (!ctx?.participant) return await sendTyping(sock, from, '⚠️ Reply pesan user dulu!', { quoted: msg })
                const target = ctx.participant.split('@')[0].replace(/[^0-9]/g, '')
                _aiBanned = _aiBanned.filter(n => n !== target)
                _saveBanned()
                return await sendTyping(sock, from, `✅ @${target} di-unban.`, { mentions: [ctx.participant], quoted: msg })
            }

            // .reset — hapus history percakapan (siapapun bisa reset milik sendiri)
            if (lower === '.reset') {
                _clearHistory(senderNum)
                return await sendTyping(sock, from, '🔄 Riwayat percakapan kamu dihapus. Mulai dari awal!', { quoted: msg })
            }

            // .limitai — cek sisa limit
            if (lower === '.limitai') {
                if (isOwner) return await sendTyping(sock, from, `♾️ *Limit kamu: Unlimited*\n👑 Owner bot tidak kena limit.`, { quoted: msg })
                const info = getAiLimitInfo(senderNum)
                if (info.unlimited) return await sendTyping(sock, from, `♾️ *Limitmu: Unlimited!*\n✅ Bisa chat kapanpun tanpa batas.`, { quoted: msg })
                const barLen = 10
                const filled = Math.round((info.sisa / info.max) * barLen)
                const bar = '█'.repeat(Math.max(0,filled)) + '░'.repeat(Math.max(0,barLen-filled))
                const tungguTxt = info.habis ? `\n⏱️ Reset dalam: *${info.tunggu} menit*` : ''
                return await sendTyping(sock, from,
                    `🤖 *LIMIT CHAT AI*\n━━━━━━━━━━━━━━━\n${bar} ${info.sisa}/${info.max}\n\n✅ Sisa: *${info.sisa}x*\n🕐 Per 45 menit${tungguTxt}`,
                    { quoted: msg })
            }

            // .ping — cek bot hidup
            if (lower === '.ping') {
                const start = Date.now()
                await sendTyping(sock, from, `🏓 Pong! ${Date.now()-start}ms\n🤖 ${BOT_NAME} aktif`, { quoted: msg })
                return
            }

            // .help — info command
            if (lower === '.help' || lower === '.menu') {
                return await sendTyping(sock, from,
                    `🤖 *${BOT_NAME} — AI Chat Bot*\n━━━━━━━━━━━━━━━\n\n💬 *Cara pakai:*\nLangsung kirim pesan apa saja, AI akan menjawab otomatis!\n\n📋 *Command:*\n◦ .reset → Hapus riwayat chat\n◦ .limitai → Cek sisa limit\n◦ .ping → Cek bot aktif\n\n👑 *Owner only:*\n◦ .aisystem on/off → Aktif/nonaktif di grup\n◦ .sapikey [key] → Set API key\n◦ .sapikey2 [key] → Set key ke-2 (max 10)\n◦ .cekkey → Lihat semua key\n◦ .promt [teks] → Set karakter AI\n◦ .glimit [n] (reply) → Tambah limit user\n◦ .glimitu (reply) → Set unlimited user\n◦ .glimitl (reply) → Reset limit user\n◦ .ban / .unban (reply) → Ban/unban user\n\n⚡ *Limit:* ${AI_LIMIT_MAX}x per 45 menit\n🔄 Key Gemini: ${_geminiKeys.length} aktif`,
                    { quoted: msg })
            }

            // ══ SKIP CONDITIONS ══

            // Skip kalau di grup dan AI off
            if (isGroup && !_isAiOn(from)) return

            // Skip kalau di-ban
            if (_aiBanned.includes(senderNum)) return

            // Skip pesan dari bot sendiri (sudah handled di atas)
            // Skip command yang tidak dikenal (dimulai . yang bukan command valid) — cukup balas juga
            // Biarkan semua pesan masuk ke AI

            // Skip kalau masih diproses (anti spam double)
            const procKey = `${from}_${senderNum}`
            if (_processing.has(procKey)) return
            _processing.add(procKey)

            // ══ LIMIT CHECK ══
            if (!isOwner) {
                const lim = checkAiLimit(senderNum)
                if (!lim.ok) {
                    _processing.delete(procKey)
                    return await sendTyping(sock, from,
                        `⏳ *Limit habis!*\n━━━━━━━━━━━━━━━\n❌ Kamu sudah chat *${AI_LIMIT_MAX}x* dalam 45 menit.\n⏱️ Tunggu *${lim.tunggu} menit* lagi.\n\n💡 Ketik *.limitai* untuk cek sisa.`,
                        { quoted: msg })
                }
            }

            // ══ PROSES AI ══
            let _aiReplySent = false
            try {
                await sock.sendPresenceUpdate('composing', from).catch(() => {})

                // ── Deteksi pertanyaan "kamu siapa / dibuat siapa" ──
                let reply
                if (_isCreatorQuestion(rawText)) {
                    reply = `Aku RomaAi, asisten AI yang dibuat sama tim RomaAi. Bisa bantu jawab pertanyaan, ngobrol, atau apapun yang kamu butuhkan! 😄`
                } else {
                    // Delay random 4–7 detik biar terasa natural
                    const _waitMs = 4000 + Math.floor(Math.random() * 3001)
                    await new Promise(r => setTimeout(r, _waitMs))

                    const history = _getHistory(senderNum)
                    reply = await askAI(rawText, senderNum, history)
                    if (!reply || reply.length < 2) throw new Error('Empty response dari Gemini')

                    _addHistory(senderNum, 'user', rawText)
                    _addHistory(senderNum, 'assistant', reply)
                }

                await sock.sendPresenceUpdate('paused', from).catch(() => {})

                // ══ TYPEWRITER: 7 kata per 10ms ══
                const _header = `RomaAi✨\n━━━━━━━━━━━━━━━\n`
                const _words = reply.split(' ')
                const _chunk = 7
                const _delay = 10

                const _firstTxt = _header + _words.slice(0, _chunk).join(' ') + (_words.length > _chunk ? ' ▍' : '')
                const _sent = await sock.sendMessage(from, { text: _firstTxt }, { quoted: msg })
                const _sentKey = _sent?.key
                _aiReplySent = true  // pesan pertama berhasil terkirim

                if (_sentKey && _words.length > _chunk) {
                    for (let i = _chunk; i < _words.length; i += _chunk) {
                        await new Promise(r => setTimeout(r, _delay))
                        const _isLast = (i + _chunk) >= _words.length
                        const _txt = _header + _words.slice(0, i + _chunk).join(' ') + (_isLast ? '' : ' ▍')
                        try {
                            // Format Baileys yang benar untuk edit pesan
                            await sock.sendMessage(from, { edit: _sentKey, text: _txt })
                        } catch(e) { break }
                    }
                }

            } catch(e) {
                console.log('[AI Error]', e.message)
                // Hanya kirim pesan error kalau belum ada reply yang terkirim
                if (!_aiReplySent) {
                    try {
                        await sock.sendPresenceUpdate('paused', from).catch(() => {})
                        await sendTyping(sock, from, '⚠️ AI lagi gangguan dikit, coba lagi bentar ya!', { quoted: msg })
                    } catch(e2) { console.log('[AI Error send]', e2.message) }
                }
            } finally {
                _processing.delete(procKey)
            }

        } catch(e) { console.log('[Handler Error]', e.message) }
    })
}

startBot()
