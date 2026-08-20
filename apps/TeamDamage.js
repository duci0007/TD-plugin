/* eslint-disable camelcase */
import { getUrlJson } from '../models/getUrlJson.js'
import plugin from '../../../lib/plugins/plugin.js'
import fs from 'fs'
import { team, parseRoleChanges } from '../models/getTeam.js'
import _ from 'lodash'
import MysApi from '../models/GetATUID.js'
import { Character } from '../../miao-plugin/models/index.js'

let DATA_PATH = `${process.cwd()}/plugins/TD-plugin/config/TeyvatConfig/TeyvatUrlJson.json`
/** 🔥 配队简称本地持久化文件（重启 Yunzai/搬服务器不丢）；自动创建目录和空文件 */
const ALIAS_FILE = `${process.cwd()}/plugins/TD-plugin/config/teamAlias.json`
/** 两步式添加的临时会话状态（用户先发简称→等待用户回角色列表）存内存 Map，10 分钟自动过期
 *  —— 完全不依赖 Redis，避免「redis.hset is not a function」的兼容问题
 *  key: String(user_id)
 *  value: { alias: 简称字符串, expireAt: 过期毫秒时间戳 } */
const PENDING_ADD_TTL_MS = 10 * 60 * 1000
const pendingAddMap = new Map()

function cleanExpiredPendingAdd () {
  const now = Date.now()
  for (const [k, v] of pendingAddMap.entries()) {
    if (!v || !v.expireAt || now > v.expireAt) pendingAddMap.delete(k)
  }
}
function setPendingAdd (userId, alias) {
  cleanExpiredPendingAdd()
  pendingAddMap.set(String(userId || 0), {
    alias: String(alias || '').trim(),
    expireAt: Date.now() + PENDING_ADD_TTL_MS
  })
}
function getPendingAdd (userId) {
  cleanExpiredPendingAdd()
  const v = pendingAddMap.get(String(userId || 0))
  if (!v || !v.expireAt || Date.now() > v.expireAt) {
    pendingAddMap.delete(String(userId || 0))
    return null
  }
  return v.alias || null
}
function delPendingAdd (userId) {
  pendingAddMap.delete(String(userId || 0))
}

// ============================================================
// 配队简称：本地文件持久化 + 展开 + 手法绑定 工具函数
// 存储结构（V2）：{ "简称": { chars: "那维莱特,芙宁娜,希诺宁,万叶", combo: "E,Q,重击,重击" | null } }
// 兼容旧 V1：{ "简称": "那维莱特,芙宁娜,希诺宁,万叶" } → 读到时自动迁移成对象
// ============================================================
function ensureAliasFile () {
  try {
    const dir = ALIAS_FILE.replace(/\/teamAlias\.json$/, '')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(ALIAS_FILE)) fs.writeFileSync(ALIAS_FILE, JSON.stringify({}, null, 2), 'utf-8')
  } catch (_) {}
}
/** 返回的 map 里每一项都会被 normalize 为 { chars, combo } 对象（旧字符串自动迁移）*/
async function getAllAliasMap () {
  try {
    ensureAliasFile()
    const text = fs.readFileSync(ALIAS_FILE, 'utf-8') || '{}'
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    let needRewrite = false
    const out = {}
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (!v) continue
      if (typeof v === 'string') {
        // 旧 V1 字符串 -> 升级
        out[k] = { chars: v, combo: null }
        needRewrite = true
      } else if (typeof v === 'object' && !Array.isArray(v)) {
        out[k] = {
          chars: String(v.chars || '').trim() || '',
          combo: String(v.combo || '').trim() || null
        }
      }
    }
    if (needRewrite) {
      try {
        fs.writeFileSync(ALIAS_FILE, JSON.stringify(out, null, 2), 'utf-8')
        logger.info('[TD-plugin]配队简称存储格式已自动升级为 V2（支持手法绑定）')
      } catch (_) {}
    }
    return out
  } catch (_) {
    return {}
  }
}
async function writeAliasMap (map) {
  ensureAliasFile()
  fs.writeFileSync(ALIAS_FILE, JSON.stringify(map, null, 2), 'utf-8')
}
async function saveAlias (alias, valueStr) {
  const k = String(alias || '').trim()
  const v = String(valueStr || '').trim()
  if (!k || !v) return false
  try {
    const map = await getAllAliasMap()
    const old = map[k] || { combo: null }
    map[k] = { chars: v, combo: old?.combo || null }
    await writeAliasMap(map)
    return true
  } catch (err) {
    logger.error(`[TD-plugin]保存配队简称失败：${err?.message || err}`)
    return false
  }
}
async function deleteAlias (alias) {
  const k = String(alias || '').trim()
  if (!k) return 0
  try {
    const map = await getAllAliasMap()
    if (!Object.prototype.hasOwnProperty.call(map, k)) return 0
    delete map[k]
    await writeAliasMap(map)
    return 1
  } catch (err) {
    logger.error(`[TD-plugin]删除配队简称失败：${err?.message || err}`)
    return 0
  }
}
async function saveAliasCombo (alias, comboStr) {
  const k = String(alias || '').trim()
  const c = String(comboStr || '').trim()
  if (!k) return { ok: false, reason: '简称不能为空' }
  const map = await getAllAliasMap()
  if (!Object.prototype.hasOwnProperty.call(map, k)) return { ok: false, reason: `配队简称「${k}」不存在，请先 #td添加配队简称` }
  map[k].combo = c || null
  try {
    await writeAliasMap(map)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) }
  }
}
async function deleteAliasCombo (alias) {
  const k = String(alias || '').trim()
  if (!k) return 0
  const map = await getAllAliasMap()
  if (!Object.prototype.hasOwnProperty.call(map, k)) return 0
  if (!map[k].combo) return 0
  map[k].combo = null
  try {
    await writeAliasMap(map)
    return 1
  } catch (_) {
    return 0
  }
}
/**
 * 简称展开：把 roleStr 文本中的别名替换成对应角色
 * 返回对象：{ charsText: 展开后的角色字符串, aliasComboFromHit: 命中的第一个简称绑定的手法（没命中或没手法就 null） }
 * 规则：命中多个简称时，优先取【最长匹配】且有 combo 的那个的手法
 */
async function expandTeamAlias (roleStr) {
  if (!roleStr) return { charsText: '', aliasComboFromHit: null }
  let out = String(roleStr)
  const map = await getAllAliasMap()
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length)
  let aliasComboFromHit = null
  let hitAny = false
  for (const [alias, obj] of entries) {
    if (!alias || !obj || !obj.chars) continue
    if (out.includes(alias)) {
      hitAny = true
      if (!aliasComboFromHit && obj.combo) aliasComboFromHit = obj.combo
      while (out.includes(alias)) out = out.replace(alias, obj.chars)
    }
  }
  return { charsText: out, aliasComboFromHit: hitAny ? aliasComboFromHit : null }
}

// ============================================================
// 手法解析：支持 inline 『角色名+动作』绑定 + 纯动作序列（按队伍顺序拼接）
//   例子1（绑定）：钟离长e,行秋q,e,e,万叶长e,q,胡桃e,a1,重击,跳跃
//   例子2（纯序列）：A,Q,重击,重击,闪避,E
// orderedRoleNames 是队伍顺序的角色名数组，对齐 0 号是谁 1 号是谁
// ============================================================
function normalizeActionToken (tok) {
  const raw = String(tok || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  // 中文别名 → 标准 token（尽量跟小程序 combo_intro 里 token 对齐）
  const aliasMap = {
    '普攻': 'A', '普通攻击': 'A', '平A': 'A', '平a': 'A',
    '战技': 'E', '元素战技': 'E', '小技能': 'E', '短e': 'E', '短E': 'E',
    '元素爆发': 'Q', '大招': 'Q', '爆发': 'Q', '大': 'Q',
    '下落': '下落攻击', '下落攻击': '下落攻击',
    '冲刺': '冲刺', '冲': '冲刺', '跑步': '冲刺',
    '跳': '跳跃',
    '闪': '闪避', '躲开': '闪避'
  }
  if (aliasMap[raw]) return aliasMap[raw]
  // 长E / 长e → 长E
  if (/^长[eE]$/.test(raw)) return '长E'
  if (/^(长|长按)[eE]$/.test(raw)) return '长E'
  // 短+E / Q 都归成大写字母
  if (/^[aA][1-5]$/.test(raw)) return raw.toUpperCase() // A1..A5
  if (/^[eEqQsS]$/.test(raw)) return raw.toUpperCase()
  if (/^[aA]$/.test(raw)) return raw.toUpperCase()
  // A重击 / Q+重击 这种 → 如果结尾是 "重击" 保留
  return raw
}
/**
 * @param {string[]} orderedRoleNames 角色名数组（按队伍顺序）
 * @param {string} rawComboText 用户输入的手法原文（逗号/中文逗号/顿号/空格分隔都行）
 * @returns {string} 拼成最终逗号分隔的手法序列；空字符串表示没有自定义手法
 */
function parseCustomCombo (orderedRoleNames, rawComboText, originalTokens) {
  if (!rawComboText) return { globalSequence: '', roleActions: [] }
  const text = String(rawComboText).trim()
  if (!text) return { globalSequence: '', roleActions: [] }
  const ordered = Array.isArray(orderedRoleNames) ? orderedRoleNames.filter(Boolean) : []
  // 先把所有分隔符统一成逗号，但保留中文（角色名里可能有中文）
  const sepNormal = text.replace(/[\s，、|;；]+/g, ',').replace(/,+/g, ',').replace(/^,+|,+$/g, '')
  if (!sepNormal) return { globalSequence: '', roleActions: [] }
  const tokens = sepNormal.split(',').filter(Boolean)
  if (!tokens.length) return { globalSequence: '', roleActions: [] }
  // 角色名规范化（全小写/去空格），顺便建倒排 idx
  const nameIdx = new Map()
  ordered.forEach((n, i) => nameIdx.set(String(n || '').replace(/\s+/g, '').toLowerCase(), i))
  // 🔥 关键修复：用户写的角色名可能跟 Character.get 标准名不一样（例如用户写"万叶"但标准名"枫原万叶"）
  //    把 originalTokens（用户原始输入的角色名）也加入 nameIdx，确保 "万叶长e" 能匹配到 "万叶"
  const origTokens = Array.isArray(originalTokens) ? originalTokens : []
  origTokens.forEach((tok, i) => {
    const n = (tok || '').split('(')[0].trim().replace(/\s+/g, '').toLowerCase()
    if (n && !nameIdx.has(n) && i < ordered.length) nameIdx.set(n, i)
  })
  const matchNamePrefix = (tok) => {
    const lower = tok.replace(/\s+/g, '').toLowerCase()
    // 精准命中：tok 整个就是角色名
    if (nameIdx.has(lower)) return { nameIdx: nameIdx.get(lower), restLen: 0 }
    // tok 前缀是角色名：最长匹配
    let best = null
    for (const [name, i] of nameIdx.entries()) {
      if (name && lower.startsWith(name)) {
        if (!best || name.length > best._n) best = { nameIdx: i, restLen: tok.length - name.length, _n: name.length }
      }
    }
    return best
  }
  // 任何一个 token 命中角色名前缀 → 绑定模式；否则纯序列模式
  const hasBindHint = tokens.some(t => !!matchNamePrefix(t))
  const collected = ordered.map(() => []) // 每个角色的动作桶（纯动作 token，不含角色名）
  const globalSequence = [] // 🔥 按 combo_intro 格式：角色名+动作,动作,角色名+动作,...（角色切换时加前缀）
  let currentRoleIdx = -1
  let lastGlobalRoleIdx = -1 // 上一条 globalSequence 动作所属角色
  for (const tok of tokens) {
    const m = hasBindHint ? matchNamePrefix(tok) : null
    if (m) {
      currentRoleIdx = m.nameIdx
      if (m.restLen > 0) {
        // 角色名后还带动作：钟离长e → 切到钟离，并把『长e』当一个动作
        const restTok = tok.slice(tok.length - m.restLen)
        const norm = normalizeActionToken(restTok)
        if (norm) {
          const roleName = ordered[currentRoleIdx] || ''
          if (currentRoleIdx !== lastGlobalRoleIdx) {
            globalSequence.push(roleName + norm)
          } else {
            globalSequence.push(norm)
          }
          lastGlobalRoleIdx = currentRoleIdx
          if (currentRoleIdx >= 0 && currentRoleIdx < ordered.length) collected[currentRoleIdx].push(norm)
        }
      }
      continue
    }
    // 没有角色名前缀
    const norm = normalizeActionToken(tok)
    if (!norm) continue
    globalSequence.push(norm) // 同角色后续动作不加前缀
    if (hasBindHint) {
      if (currentRoleIdx < 0) {
        const idx = collected.findIndex(arr => arr.length === 0)
        currentRoleIdx = idx >= 0 ? idx : 0
      }
      if (currentRoleIdx >= 0 && currentRoleIdx < ordered.length) {
        collected[currentRoleIdx].push(norm)
      }
    }
  }
  return {
    globalSequence: globalSequence.join(','),
    roleActions: collected
  }
}

export class TeamDamage extends plugin {
  constructor () {
    super({
      name: '提瓦特队伍伤害',
      dsc: '提瓦特小助手队伍伤害计算，提取自 FanSky_Qs',
      event: 'message',
      priority: 3141,
      rule: [
        {
          reg: /^#队伍伤害(详情|过程|全图)?(\d+)?(.*)$/,
          fnc: 'TeyvatEnTry'
        },
        {
          reg: /#更新小助手配置/,
          fnc: 'UpdataJSON'
        },
        // 【配队简称管理】：兼容带/不带 #td 前缀
        {
          reg: /^#(td\s*)?(添加|新增|加|设置)\s*(配队)?(简称|别名)/i,
          fnc: 'CmdAddTeamAlias',
          log: false
        },
        {
          reg: /^#(td\s*)?(删除|移除|删|取消)\s*(配队)?(简称|别名)/i,
          fnc: 'CmdDelTeamAlias',
          log: false
        },
        {
          reg: /^#(td\s*)?(配队)?(简称|别名)\s*(列表|清单|查看|所有)?$/i,
          fnc: 'CmdListTeamAlias',
          log: false
        },
        // 【自定义手法管理】
        {
          reg: /^#(td\s*)?(设置|修改|加|新增)\s*(自定义)?\s*手法/i,
          fnc: 'CmdSetCombo',
          log: false
        },
        {
          reg: /^#(td\s*)?(删除|移除|删|取消|清)\s*(自定义)?\s*手法/i,
          fnc: 'CmdDelCombo',
          log: false
        },
        {
          reg: /^#(td\s*)?(自定义)?\s*手法\s*(列表|清单|查看|所有)?$/i,
          fnc: 'CmdListCombo',
          log: false
        },
        // 【帮助】
        {
          reg: /^#(td\s*)?(帮助|help|菜单|说明|使用|指南|指令|命令)(\s*列表)?$/i,
          fnc: 'CmdHelp',
          log: false
        },
        // 【兜底】两步式添加简称：用户上一条发了 #td添加配队简称（两步式）
        // → 下一条任意消息如果命中 pendingAddMap，就当作角色列表处理
        // 注意：这条必须放在 rule 数组最后面；return false 会把消息放行给其他插件
        {
          reg: /.*/,
          fnc: 'HandlePendingAlias',
          log: false
        }
      ]
    })
  }

  // ============================================================
  // 配队简称：两步式对话（弃用 Yunzai setContext，改走 rule 兜底匹配 + 内存 pendingAddMap）
  // ============================================================
  async CmdAddTeamAlias (e) {
    // 支持两种语法：
    //  1) 一步式：#td添加配队简称 龙芙希万 = 那维莱特，芙宁娜，希诺宁，万叶
    //  2) 两步式：#td添加配队简称 龙芙希万 → 回复「请输入角色名（逗号分隔，2~4个）」 → 用户再回角色列表
    const raw = String(e.msg || '').replace(/^#(td\s*)?(添加|新增|加|设置)\s*(配队)?(简称|别名)\s*/i, '').trim()
    if (!raw) {
      e.reply('用法：\n一步式：#td添加配队简称 龙芙希万 = 那维莱特,芙宁娜,希诺宁,万叶\n两步式：#td添加配队简称 龙芙希万 → 然后再回复对应的角色（用逗号分隔）', true)
      return true
    }
    // 一步式：包含 = ／ ＝ ／ ： ／ : 分隔的 alias 和角色列表
    let alias = ''
    let chars = ''
    const mOne = raw.match(/^\s*([^=＝：:~～]+?)\s*[=＝：:~～]\s*(.+?)\s*$/)
    if (mOne) {
      alias = mOne[1].trim()
      chars = mOne[2].trim()
    } else {
      alias = raw
    }
    if (!alias) {
      e.reply('请带上简称，例如：#td添加配队简称 龙芙希万 = 那维莱特,芙宁娜,希诺宁,万叶', true)
      return true
    }
    if (chars) {
      // 一步式：直接保存
      const clean = chars.replace(/[\s\|、。\-]+/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '')
      const arr = clean.split(',').filter(Boolean)
      if (arr.length < 2) {
        e.reply(`角色至少 2 个哦，现在只识别到 ${arr.length} 个：${arr.join('、')}`, true)
        return true
      }
      const ok = await saveAlias(alias, clean)
      if (ok) {
        e.reply(`✅ 配队简称「${alias}」已保存：\n→ ${arr.join('、')}（共 ${arr.length} 人）\n现在直接用 #队伍伤害 ${alias} 就能算伤害咯！`, true)
      } else {
        e.reply('保存失败，简称或角色不能为空', true)
      }
      return true
    }
    // 两步式：把这个 userId → alias 存内存 Map（10 分钟自动过期），下一条消息由 HandlePendingAlias 兜底匹配处理
    setPendingAdd(e.user_id, alias)
    e.reply(`请在 10 分钟内回复【角色名（2~4 个，用逗号/空格/顿号分隔）】：\n为简称「${alias}」配角色，例如：那维莱特,芙宁娜,希诺宁,万叶`, true)
    return true
  }

  /**
   * 兜底 handler：匹配任意消息（放在 rule 数组最后）
   *  - 只有当当前用户存在 pendingAdd（两步式添加简称等待中）时才会消费
   *  - 否则直接 return false，把消息放行给其他插件/其他 rule
   */
  async HandlePendingAlias (e) {
    // 1) 如果这条消息本身是 TD-plugin 的命令，直接放行（避免循环/抢命令）
    const msg = String(e.msg || '')
    if (/^#(td\s*)?(添加|新增|加|设置|删除|移除|删|取消)\s*(配队)?(简称|别名)/i.test(msg) ||
        /^#(td\s*)?(配队)?(简称|别名)\s*(列表|清单|查看|所有)?$/i.test(msg) ||
        /^#队伍伤害(详情|过程|全图)?(\d+)?(.*)$/.test(msg) ||
        /#更新小助手配置/.test(msg)) {
      return false
    }
    // 2) 只有存在 pending 简称时才进入处理
    const alias = getPendingAdd(e.user_id)
    if (!alias) return false
    delPendingAdd(e.user_id)
    // 3) 如果用户回的是「取消/算了/不添加/不要了」之类，直接取消不报错
    const rolesStr = msg.trim()
    if (!rolesStr || /^(取消|算了|不|不要|不要了|不添加|退出|cancel|quit)\s*$/i.test(rolesStr)) {
      e.reply(`已取消添加配队简称「${alias}」`, true)
      return true
    }
    const clean = rolesStr.replace(/[\s\|、。\-]+/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '')
    const arr = clean.split(',').filter(Boolean)
    if (arr.length < 2) {
      e.reply(`角色至少 2 个哦，现在只识别到 ${arr.length} 个：${arr.join('、')}，保存取消`, true)
      return true
    }
    const ok = await saveAlias(alias, clean)
    if (ok) {
      e.reply(`✅ 配队简称「${alias}」已保存：\n→ ${arr.join('、')}（共 ${arr.length} 人）\n现在直接用 #队伍伤害 ${alias} 就能算伤害咯！`, true)
    } else {
      e.reply('保存失败，请重试', true)
    }
    return true
  }

  async CmdDelTeamAlias (e) {
    const raw = String(e.msg || '').replace(/^#(td\s*)?(删除|移除|删|取消)\s*(配队)?(简称|别名)\s*/i, '').trim()
    if (!raw) {
      const map = await getAllAliasMap()
      const keys = Object.keys(map)
      if (!keys.length) {
        e.reply('当前还没有任何配队简称', true)
        return true
      }
      e.reply(`请指定要删除的简称，例如：#td删除配队简称 龙芙希万\n当前已有简称：${keys.join(' / ')}`, true)
      return true
    }
    // 支持同时删多个（空格/逗号分隔）
    const map = await getAllAliasMap()
    const aliases = raw.split(/[\s,，、]+/).filter(Boolean)
    let removed = 0
    let notFound = []
    for (const k of aliases) {
      const existed = Object.prototype.hasOwnProperty.call(map, k)
      if (existed) {
        removed += await deleteAlias(k)
      } else {
        notFound.push(k)
      }
    }
    let msg = ''
    if (removed > 0) msg += `✅ 已删除 ${removed} 个配队简称：${aliases.filter(k => !notFound.includes(k)).join('、')}\n`
    if (notFound.length) msg += `⚠️ 未找到：${notFound.join('、')}`
    e.reply(msg || '删除失败', true)
    return true
  }

  async CmdListTeamAlias (e) {
    const map = await getAllAliasMap()
    const keys = Object.keys(map)
    if (!keys.length) {
      e.reply('当前没有任何配队简称。\n添加例子：\n#td添加配队简称 龙芙希万 = 那维莱特,芙宁娜,希诺宁,万叶', true)
      return true
    }
    keys.sort((a, b) => a.length - b.length)
    const lines = keys.map((k, i) => {
      const obj = map[k] || {}
      const arr = String(obj.chars || '').split(',').filter(Boolean)
      const combo = String(obj.combo || '').trim()
      return `${i + 1}. 【${k}】 → ${arr.join('、')}（${arr.length}人）${combo ? `\n     ✋手法：${combo}` : ''}`
    })
    const head = `📒 已有 ${keys.length} 个配队简称（发 #队伍伤害 <简称> 直接用）：\n`
    const tail = '\n\n管理：\n添加简称：#td添加配队简称 龙芙希万 = 那维莱特,芙宁娜,希诺宁,万叶\n删除简称：#td删除配队简称 龙芙希万\n设置手法：#td设置手法 龙芙希万 = 那维莱特Q,芙宁娜E,希诺宁Q,万叶长E'
    e.reply(head + lines.join('\n') + tail, true)
    return true
  }

  // ============================================================
  // 自定义手法绑定简称（持久化）
  // ============================================================
  async CmdSetCombo (e) {
    const raw = String(e.msg || '').replace(/^#(td\s*)?(设置|修改|加|新增)\s*(自定义)?\s*手法\s*/i, '').trim()
    // 支持一步式：简称 =／＝／：／: 手法
    let alias = '', combo = ''
    const m = raw.match(/^\s*([^=＝：:~～]+?)\s*[=＝：:~～]\s*(.+?)\s*$/)
    if (m) {
      alias = m[1].trim()
      combo = m[2].trim()
    }
    if (!alias) {
      e.reply('用法：\n#td设置手法 龙芙希万 = 胡桃E,钟离长E,行秋Q,E,E,万叶长E,Q\n（支持 inline 角色名绑定动作）', true)
      return true
    }
    if (!combo) {
      e.reply('手法不能为空，例子：#td设置手法 龙芙希万 = E,Q,重击,重击,闪避', true)
      return true
    }
    // 手法先做一次规范化（逗号分隔即可，token 规范化在 parse 里）
    const comboClean = combo.replace(/[\s，、|;；]+/g, ',').replace(/,+/g, ',').replace(/^,+|,+$/g, '')
    const res = await saveAliasCombo(alias, comboClean)
    if (res.ok) {
      e.reply(`✅ 配队简称「${alias}」手法已保存：\n👉 ${comboClean}\n下次发 #队伍伤害 ${alias} 会自动用该手法～`, true)
    } else {
      e.reply(`保存失败：${res.reason || '未知错误'}`, true)
    }
    return true
  }

  async CmdDelCombo (e) {
    const raw = String(e.msg || '').replace(/^#(td\s*)?(删除|移除|删|取消|清)\s*(自定义)?\s*手法\s*/i, '').trim()
    const aliases = raw.split(/[\s,，、]+/).filter(Boolean)
    if (!aliases.length) {
      const map = await getAllAliasMap()
      const withCombo = Object.entries(map).filter(([, obj]) => obj?.combo).map(([k]) => k)
      e.reply(withCombo.length
        ? `请指定要清空手法的简称，多个用空格分隔。例如：#td删除手法 龙芙希万 胡钟夜莫\n当前有手法的简称：${withCombo.join(' / ')}`
        : '当前没有任何简称绑定手法', true)
      return true
    }
    let removed = 0
    let notFound = []
    for (const a of aliases) {
      const r = await deleteAliasCombo(a)
      if (r > 0) removed += r
      else notFound.push(a)
    }
    let msg = ''
    if (removed) msg += `✅ 已清空 ${removed} 个简称的手法：${aliases.filter(a => !notFound.includes(a)).join('、')}\n`
    if (notFound.length) msg += `⚠️ 未找到或本来就没手法：${notFound.join('、')}`
    e.reply(msg || '删除失败', true)
    return true
  }

  async CmdListCombo (e) {
    const map = await getAllAliasMap()
    const entries = Object.entries(map).filter(([, obj]) => obj?.combo)
    if (!entries.length) {
      e.reply('当前没有任何简称绑定手法。\n绑定例子：#td设置手法 龙芙希万 = 那维莱特Q,芙宁娜E,希诺宁Q,万叶长E', true)
      return true
    }
    entries.sort((a, b) => a[0].length - b[0].length)
    const lines = entries.map(([k, obj], i) => {
      const arr = String(obj.chars || '').split(',').filter(Boolean)
      return `${i + 1}. 【${k}】 ${arr.join('、')}（${arr.length}人）\n     ✋手法：${obj.combo}`
    })
    e.reply(`🎯 已绑定手法的配队简称（共 ${entries.length} 个）：\n${lines.join('\n')}\n\n删除：#td删除手法 简称1 简称2`, true)
    return true
  }

  async CmdHelp (e) {
    const helpGroup = [
      {
        group: '🔹 队伍伤害计算',
        list: [
          { title: '#队伍伤害 胡桃,钟离,夜兰,莫娜', desc: '计算4人队伍伤害（默认模式）' },
          { title: '#队伍伤害 龙芙希万', desc: '用配队简称替代角色名' },
          { title: '#队伍伤害详情 胡桃,钟离,夜兰,莫娜', desc: '计算并显示详细过程' },
          { title: '#队伍伤害189746685 胡桃,钟离', desc: '指定UID查询他人账号' }
        ]
      },
      {
        group: '🔹 自定义手法（inline 临时写）',
        list: [
          { title: '#队伍伤害 胡桃,钟离,行秋,万叶 钟离长e,行秋q,e,e...', desc: '角色名+动作前缀绑定，同角色后续动作无需重复写角色名' },
          { title: '动作支持：A/A1/A2/E/Q/重击/长E/跳跃/闪避', desc: '大小写通用，逗号/空格/顿号分隔均可' }
        ]
      },
      {
        group: '🔹 角色信息变更（换命座/武器/圣遗物）',
        list: [
          { title: '#队伍伤害 胡桃,钟离,夜兰换六命换若水换精5换4饰金,莫娜', desc: '给夜兰换6命+若水+精5+4饰金之梦' },
          { title: '换六命/五命/.../零命', desc: '变更命座' },
          { title: '换精5/精1/...', desc: '变更武器精炼（精5=精炼5阶）' },
          { title: '换若水/换护摩/...', desc: '变更武器（支持常见武器名）' },
          { title: '换4饰金/换4魔女/换4绝缘/...', desc: '变更圣遗物套装（可简写：饰金=饰金之梦）' },
          { title: '换a10/换e10/换q10', desc: '变更天赋等级（a=普攻/e=战技/q=爆发）' },
          { title: '换90/换80', desc: '变更角色等级' }
        ]
      },
      {
        group: '🔹 配队简称管理',
        list: [
          { title: '#td添加配队简称 龙芙希万 = 那维莱特,芙宁娜,希诺宁,万叶', desc: '一步式保存配队简称（推荐）' },
          { title: '#td添加配队简称 龙芙希万', desc: '两步式：先发简称，再回复角色列表' },
          { title: '#td删除配队简称 龙芙希万 雷国', desc: '删除一个或多个配队简称（空格分隔）' },
          { title: '#td配队简称列表', desc: '查看所有已保存的配队简称' }
        ]
      },
      {
        group: '🔹 自定义手法管理（绑定到简称）',
        list: [
          { title: '#td设置手法 龙芙希万 = 芙宁娜e,q,希诺宁e,a1,a2...', desc: '绑定手法到简称，之后 #队伍伤害 简称 自动使用' },
          { title: '#td删除手法 龙芙希万', desc: '清空某个简称的绑定手法（不删配队）' },
          { title: '#td手法列表', desc: '查看所有已绑定手法的配队简称' }
        ]
      },
      {
        group: '🔹 其他',
        list: [
          { title: '#td帮助 / #td菜单 / #td指令', desc: '显示本帮助' },
          { title: '#更新小助手配置', desc: '更新提瓦特小助手JSON缓存' }
        ]
      }
    ]
    const tips = [
      '角色名之间用逗号/空格/顿号分隔均可',
      '手法动作：A/A1/A2/E/Q/重击/长E/跳跃/闪避',
      '角色名+动作前缀绑定：钟离长e, 行秋q,e,e',
      '同角色后续动作无需重复写角色名',
      '换命座/武器/圣遗物：夜兰换六命换若水换精5换4饰金',
      '配队简称存本地文件，重启/搬家不丢',
      '命令中 #td 前缀可省略'
    ]

    try {
      const renderer = (await import('../../../lib/puppeteer/puppeteer.js')).default
      const img = await renderer.screenshot('td-help', {
        tplFile: './plugins/TD-plugin/resources/help/index.html',
        helpCfg: {
          title: 'TD-plugin 帮助',
          subTitle: '队伍伤害计算 · 配队简称管理 · 自定义手法',
          copyright: 'TD-plugin · 基于 Yunzai-Bot & 提瓦特小助手'
        },
        helpGroup,
        tips
      })
      if (img) {
        e.reply(img)
      } else {
        e.reply('帮助图片生成失败，请稍后重试', true)
      }
    } catch (err) {
      logger.error(`[TD-plugin]生成帮助图失败：${err?.message || err}`)
      e.reply('帮助图片生成失败，请稍后重试', true)
    }
    return true
  }

  async TeyvatEnTry (e) {
    let at = e.at
    const regexTeam = /^#队伍伤害(详情|过程|全图)?(\d+)?(.*)$/
    let uid, roleList, detail
    if (e.msg.includes('#队伍伤害')) {
      const matchTeam = e.msg.match(regexTeam)
      uid = matchTeam[2] ? matchTeam[2] : await this.GetNowUid(e)
      if (at) {
        let AT_UID = await MysApi.getAT_UID(e, 'all')
        if (!AT_UID) {
          AT_UID = (await redis.get(`genshin:id-uid:${at}`)) || (await redis.get(`Yz:genshin:mys:qq-uid:${at}`))
        }
        if (AT_UID) {
          uid = AT_UID
        } else {
          e.reply(`QQ:${at}尚未绑定uid~\n请该用户先【#绑定uid】`)
          return true
        }
      }
      roleList = matchTeam[3]
      detail = !!matchTeam[1]
      logger.info(e.msg)
    } else {
      logger.info('用户指令：' + e.msg)
      return false
    }
    if (!uid) {
      e.reply('尚未绑定uid，请先【#绑定xxx】\n直接指定查询：#队伍伤害100000000钟离，阿贝多，可莉,魈')
      return true
    }
    if (!roleList) {
      e.reply('指令错误，使用例子：\n#队伍伤害(@张三)钟离，阿贝多，可莉，魈\n#队伍伤害100000000钟离，阿贝多，可莉，魈', true, { recallMsg: 30 })
      return true
    }
    // 🔥【配队简称展开】：把消息里含有的简称先翻译成完整角色名，同时取命中简称绑定的手法（回落 default=null）
    const expanded = await expandTeamAlias(roleList)
    const aliasExpandedText = expanded.charsText || ''
    const aliasCombo = expanded.aliasComboFromHit || null
    if (aliasExpandedText !== roleList) {
      logger.info(`[TD-plugin]配队简称替换：原『${roleList}』→ 展开后『${aliasExpandedText}』${aliasCombo ? '，命中手法（简称绑定）=' + aliasCombo : ''}`)
    }

    // 🔥【换XX角色变更解析】：按中文逗号/英文逗号先拆成角色条目，检测含「换」的条目拆出角色名+变更参数
    const rawEntries = aliasExpandedText.split(/[，,]/).filter(Boolean)
    const cleanRoleNames = []
    const roleChangesArr = []
    for (const entry of rawEntries) {
      const trimmed = entry.trim()
      if (trimmed.includes('换')) {
        const parts = trimmed.split('换')
        const roleName = parts[0].trim()
        const changeTokens = parts.slice(1).map(s => s.trim()).filter(Boolean)
        if (roleName) {
          cleanRoleNames.push(roleName)
          const changes = parseRoleChanges(changeTokens, roleName)
          roleChangesArr.push(changes)
          if (changes) {
            logger.info(`[TD-plugin]角色变更[${roleName}]：${JSON.stringify(changes)}`)
          }
        }
      } else {
        cleanRoleNames.push(trimmed)
        roleChangesArr.push(null)
      }
    }
    const cleanRoleList = cleanRoleNames.join('，')

    // 🔥【切分：角色名 vs 手法原文】：按分隔符拆 token，从前往后贪婪取"能命中角色"的 1~4 个，剩的就当手法原文
    const splitter = /[\s,，、。\-|]+/
    const allTokens = cleanRoleList.trim().split(splitter).filter(Boolean)
    const roleTokens = []
    let comboText = ''
    // 用 miao-plugin Character.get 验证是否是合法角色名（跟 team() 里判断角色一致）
    try {
      for (const tok of allTokens) {
        if (roleTokens.length >= 4) break
        // role name 可能带括号 (元素)，比如 那维莱特(水)
        const nameOnly = tok.split('(')[0].trim()
        const hitChar = Character.get(nameOnly)
        if (hitChar) {
          roleTokens.push(tok)
        } else {
          break
        }
      }
    } catch (_) {
      // Character.get 异常就按原 split 处理
    }
    if (roleTokens.length > 0) {
      const usedLen = roleTokens.join(' ').length
      // 剩的原文从 aliasExpandedText 截掉角色段就行；如果取不到就用 allTokens 里剩余部分拼成
      const leftoverTokens = allTokens.slice(roleTokens.length)
      comboText = leftoverTokens.join(',')
    } else {
      // 一个角色都没命中（可能都是简称又没扩开的极端情况）→ 原来的 split 逻辑兜底
      roleTokens.push(...allTokens)
      comboText = ''
    }

    // 🔥【自定义手法最终字符串】优先级：inline 用户写的 > 简称绑定的
    let customComboFinal = '' // 纯动作时序（逗号分隔，不含角色名，发给 custom_combo）
    let customRoleActionsFinal = [] // 分角色动作桶 [[那维动作...],[芙宁娜动作...],...]，用来生成接口标准 custom JSON 结构
    const orderedNames = roleTokens.map(tok => {
      const n = (tok || '').split('(')[0].trim()
      const c = Character.get(n)
      return c?.name || n
    }).filter(Boolean)
    if (comboText) {
      try {
        const parsed = parseCustomCombo(orderedNames, comboText, roleTokens) || { globalSequence: '', roleActions: [] }
        customComboFinal = parsed.globalSequence || ''
        customRoleActionsFinal = Array.isArray(parsed.roleActions) ? parsed.roleActions : []
      } catch (err) {
        logger.warn(`[TD-plugin]解析 inline 手法出错：${err?.message || err}`)
      }
    }
    if (!customComboFinal && aliasCombo) {
      try {
        const parsed = parseCustomCombo(orderedNames, aliasCombo, roleTokens) || { globalSequence: '', roleActions: [] }
        customComboFinal = parsed.globalSequence || ''
        customRoleActionsFinal = Array.isArray(parsed.roleActions) ? parsed.roleActions : []
      } catch (err) {
        logger.warn(`[TD-plugin]回落简称手法解析出错：${err?.message || err}`)
        customComboFinal = aliasCombo
        customRoleActionsFinal = []
      }
    }
    // 把角色桶长度 padding 到跟 orderedNames 一样（避免 team 里 custom JSON 组装索引错位）
    while (customRoleActionsFinal.length < orderedNames.length) customRoleActionsFinal.push([])

    await team(e, _.compact(roleTokens), uid, detail, customComboFinal, customRoleActionsFinal, roleChangesArr)
    return true
  }

  async GetNowUid (e) {
    let NoteUser = e.user
    let Uid = NoteUser._regUid || NoteUser.uid
    if (!Uid) Uid = e.user.getUid('gs')
    return Uid
  }

  async UpdataJSON (e) {
    e.reply('>>>[TD-plugin]正在更新提瓦特小助手JSON...')
    await this.UPJSON(e)
    return true
  }

  async UPJSON (e) {
    let PATH = DATA_PATH.replace(/\\/g, '/')
    if (!fs.existsSync(PATH)) {
      fs.mkdirSync(PATH.replace(/\/TeyvatUrlJson.json$/, ''), { recursive: true })
      fs.writeFileSync(PATH, '{}')
    }
    let DATA_JSON = JSON.parse(fs.readFileSync(PATH))
    let CHAR_DATA = await getUrlJson('char-data.json', e)
    let HASH_TRANS = await getUrlJson('hash-trans.json', e)
    let CALC_RULES = await getUrlJson('calc-rule.json', e)
    let RELIC_APPEND = await getUrlJson('relic-append.json', e)
    DATA_JSON.CHAR_DATA = CHAR_DATA
    DATA_JSON.HASH_TRANS = HASH_TRANS
    DATA_JSON.CALC_RULES = CALC_RULES
    DATA_JSON.RELIC_APPEND = RELIC_APPEND
    fs.writeFileSync(PATH, JSON.stringify(DATA_JSON))
    logger.info(logger.magenta('>>>已写入CHAR_DATA配置项 '))
    logger.info(logger.magenta('>>>已写入HASH_TRANS配置项 '))
    logger.info(logger.magenta('>>>已写入CALC_RULES配置项 '))
    logger.info(logger.magenta('>>>已写入RELIC_APPEND配置项 '))
    e.reply('>>>[TD-plugin]提瓦特小助手JSON更新完成！')
  }
}
