const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// --- ĐỌC CẤU HÌNH TELEGRAM OTP & PHÂN QUYỀN CƠ SỞ ---
const configPath = path.join(__dirname, 'config.json');
function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return { telegramBotToken: '', notify: { orders: true, bookings: true, control: true }, admins: [] };
  }
}

function normalizePhone(p) {
  let s = String(p || '').replace(/\D/g, '');
  if (s.startsWith('84') && s.length >= 10) s = '0' + s.slice(2);
  return s;
}

// --- DATABASE LAYER ---
let dbAdapter;
const sqlitePath = path.join(__dirname, 'database.sqlite');
const jsonPath = path.join(__dirname, 'database.json');

try {
  const { DatabaseSync } = require('node:sqlite');
  const sqlite = new DatabaseSync(sqlitePath);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS store (
      collection TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (collection, doc_id)
    );
    CREATE INDEX IF NOT EXISTS idx_col ON store(collection);
  `);
  const stmtGetCol = sqlite.prepare('SELECT doc_id, data FROM store WHERE collection = ?');
  const stmtGetDoc = sqlite.prepare('SELECT data FROM store WHERE collection = ? AND doc_id = ?');
  const stmtUpsert = sqlite.prepare('INSERT OR REPLACE INTO store (collection, doc_id, data, updated_at) VALUES (?, ?, ?, ?)');
  const stmtDelete = sqlite.prepare('DELETE FROM store WHERE collection = ? AND doc_id = ?');

  dbAdapter = {
    type: 'SQLite (database.sqlite)',
    getCol: (col) => stmtGetCol.all(col).map(r => ({ id: r.doc_id, data: JSON.parse(r.data) })),
    getDoc: (col, id) => {
      const r = stmtGetDoc.get(col, id);
      return r ? { exists: true, id, data: JSON.parse(r.data) } : { exists: false, id, data: null };
    },
    setDoc: (col, id, data) => stmtUpsert.run(col, id, JSON.stringify(data), Date.now()),
    delDoc: (col, id) => stmtDelete.run(col, id)
  };
} catch (e) {
  let store = {};
  if (fs.existsSync(jsonPath)) {
    try { store = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (err) {}
  }
  const flush = () => fs.writeFileSync(jsonPath, JSON.stringify(store, null, 2), 'utf8');
  dbAdapter = {
    type: 'JSON File (database.json)',
    getCol: (col) => Object.entries(store[col] || {}).map(([id, data]) => ({ id, data })),
    getDoc: (col, id) => {
      const d = store[col] && store[col][id];
      return d !== undefined ? { exists: true, id, data: d } : { exists: false, id, data: null };
    },
    setDoc: (col, id, data) => {
      if (!store[col]) store[col] = {};
      store[col][id] = data;
      flush();
    },
    delDoc: (col, id) => {
      if (store[col]) {
        delete store[col][id];
        flush();
      }
    }
  };
}

// Khởi tạo tài khoản nhân viên mẫu (nv1 / PIN: 1234) nếu database trống
if (dbAdapter.getCol('staff').length === 0) {
  const hash = crypto.createHash('sha256').update('demo:1234').digest('hex');
  dbAdapter.setDoc('staff', 'sdemo', {
    id: 'sdemo', name: 'Nhân viên mẫu', user: 'nv1',
    salt: 'demo', hash, pos: 'Thu ngân', branch: 'b1',
    wage: 25000, status: 'active', role: 'staff', phone: '0900000000'
  });
}

// --- HỆ THỐNG GỬI THÔNG BÁO TELEGRAM THEO TỪNG CƠ SỞ ---
const fmtMoney = (n) => Number(n || 0).toLocaleString('vi-VN') + 'đ';

function getBranchName(brId) {
  if (!brId) return 'Cơ sở 1';
  const siteCfg = dbAdapter.getDoc('site', 'config');
  if (siteCfg.exists && siteCfg.data && Array.isArray(siteCfg.data.branches)) {
    const found = siteCfg.data.branches.find(b => b.id === brId);
    if (found && found.name) return `${found.name} (${brId})`;
  }
  return brId === 'b1' ? 'Cơ sở 1 (b1)' : brId === 'b2' ? 'Cơ sở 2 (b2)' : brId === 'b3' ? 'Cơ sở 3 (b3)' : `Cơ sở (${brId})`;
}

async function sendTelegramToBranch(branchId, text) {
  const cfg = getConfig();
  const botToken = String(cfg.telegramBotToken || '').trim();
  if (!botToken || botToken === 'DAN_MA_BOT_TOKEN_VAO_DAY') return;

  const admins = Array.isArray(cfg.admins) ? cfg.admins : [];
  // Lọc những quản lý phụ trách đúng cơ sở này HOẶC quản lý tổng ('all')
  const targets = admins.filter(a => {
    const cid = String(a.telegramChatId || '').trim();
    if (!cid || cid.startsWith('DAN_CHAT_ID')) return false;
    const abr = String(a.branch || 'all').trim();
    return abr === 'all' || !branchId || abr === branchId;
  });

  // Tránh gửi trùng nếu 2 dòng dùng chung 1 chatId
  const uniqueChatIds = [...new Set(targets.map(t => String(t.telegramChatId).trim()))];
  for (const chatId of uniqueChatIds) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      });
    } catch (e) {
      console.error('Lỗi gửi thông báo Telegram:', e.message);
    }
  }
}

// --- MÀN HÌNH KHÁCH: tự chuyển sang "Đã thanh toán" khi nhân viên ghi nhận đơn ---
function markDisplayPaid(sale) {
  try {
    const br = sale.br || 'b1';
    const cur = dbAdapter.getDoc('display', br);
    if (!cur.exists || !cur.data || cur.data.status !== 'pay') return;
    const sameRoom = !cur.data.room || !sale.room || cur.data.room === sale.room;
    const sameAmount = Number(cur.data.amount || 0) === Number(sale.amount || 0);
    if (!sameRoom || !sameAmount) return;
    dbAdapter.setDoc('display', br, { ...cur.data, status: 'paid', method: sale.method || '', paidAt: Date.now(), t: Date.now() });
    io.emit('db_change', { col: 'display', id: br });
  } catch (e) { console.error('Lỗi cập nhật màn hình khách:', e.message); }
}

function handleTelegramEvent(col, id, data, oldDoc, isDelete) {
  if (col === 'sales' && data && !isDelete) markDisplayPaid(data);
  const cfg = getConfig();
  const notify = cfg.notify || { orders: true, bookings: true, control: true };

  // 1. THÔNG BÁO ĐƠN HÀNG & THANH TOÁN (sales, sessions)
  if (notify.orders !== false) {
    if (col === 'sales' && data && !isDelete) {
      const br = data.br || 'b1';
      const brName = getBranchName(br);
      const methodMap = { cash: 'Tiền mặt', bank: 'Chuyển khoản', card: 'Thẻ' };
      const method = methodMap[data.method] || data.method || 'Tiền mặt';
      const itemsText = Array.isArray(data.items) && data.items.length
        ? '\n• Chi tiết món: ' + data.items.map(i => `${i.name} x${i.qty}`).join(', ')
        : '';
      const disc = Number(data.discount || 0);
      const gross = Number(data.grossAmount || (Number(data.amount || 0) + disc));
      let promoText = '';
      if (disc > 0) {
        const isManual = data.promoType === 'manual';
        const icon = isManual ? '⚠️' : '🎟️';
        const label = isManual
          ? `GIẢM GIÁ TRỰC TIẾP: -${fmtMoney(disc)} (Lý do: ${data.promoNote || 'Không ghi'})`
          : `Áp dụng ưu đãi/Voucher [${data.promoCode || data.promoTitle || 'KM'}]: -${fmtMoney(disc)}`;
        promoText = `\n• Giá gốc trước giảm: ${fmtMoney(gross)}\n${icon} <b>${label}</b>`;
      }
      const msg = `💰 <b>ĐƠN HÀNG / THANH TOÁN MỚI</b>\n`
        + `🏢 Cơ sở: <b>${brName}</b>\n`
        + `🚪 Phòng/Loại: <b>${data.room || 'Bán lẻ'}</b> (${data.mins || 0} phút)\n`
        + `💵 Thực thu: <b>${fmtMoney(data.amount)}</b> (Giờ: ${fmtMoney(data.hat)} | Đồ: ${fmtMoney(data.goods)})${promoText}\n`
        + `💳 Thanh toán: ${method}\n`
        + `👤 Thu ngân: ${data.byName || 'Nhân viên'}${itemsText}`;
      sendTelegramToBranch(br, msg);
    }

    // Khách/nhân viên gọi thêm món vào phòng đang hát
    if (col === 'sessions' && data && !isDelete && oldDoc && oldDoc.exists && oldDoc.data) {
      const oldItems = oldDoc.data.items || [];
      const newItems = data.items || [];
      const oldTotalQty = oldItems.reduce((s, i) => s + (i.qty || 0), 0);
      const newTotalQty = newItems.reduce((s, i) => s + (i.qty || 0), 0);
      if (newTotalQty > oldTotalQty) {
        const br = data.br || (id.includes('__') ? id.split('__')[0] : 'b1');
        const brName = getBranchName(br);
        const list = newItems.map(i => `${i.name} (x${i.qty})`).join(', ');
        const msg = `🍻 <b>ĐƠN GỌI MÓN TẠI PHÒNG</b>\n`
          + `🏢 Cơ sở: <b>${brName}</b>\n`
          + `🚪 Phòng: <b>${data.room || id}</b>\n`
          + `📋 Danh sách hiện tại: ${list}`;
        sendTelegramToBranch(br, msg);
      }
    }
  }

  // 2. THÔNG BÁO KHÁCH ĐẶT PHÒNG TRƯỚC & HÀNG CHỜ (bookings, queue)
  if (notify.bookings !== false) {
    if (col === 'bookings' && data && Array.isArray(data.items)) {
      const oldItems = (oldDoc && oldDoc.exists && oldDoc.data && Array.isArray(oldDoc.data.items)) ? oldDoc.data.items : [];
      const oldMap = new Map(oldItems.map(i => [i.id, i]));

      for (const item of data.items) {
        const prev = oldMap.get(item.id);
        const br = item.br || 'b1';
        const brName = getBranchName(br);

        // Đơn đặt phòng mới hoàn toàn
        if (!prev) {
          const msg = `📅 <b>KHÁCH ĐẶT PHÒNG TRƯỚC MỚI</b>\n`
            + `🏢 Cơ sở: <b>${brName}</b>\n`
            + `👤 Khách hàng: <b>${item.name || 'Khách'}</b>\n`
            + `📞 SĐT liên hệ: <b>${item.phone || 'Không có'}</b>\n`
            + `🚪 Phòng: <b>${item.roomId || ''}</b>\n`
            + `⏰ Thời gian: <b>${item.time || ''} ngày ${item.date || ''}</b> (${item.mins || 60} phút)`;
          sendTelegramToBranch(br, msg);
        } else if (prev.status !== item.status && item.status !== 'done') {
          const stMap = { confirmed: 'Đã xác nhận giữ phòng', cancelled: 'Đã hủy lịch đặt' };
          const stText = stMap[item.status] || item.status;
          const msg = `🔔 <b>CẬP NHẬT LỊCH ĐẶT PHÒNG</b>\n`
            + `🏢 Cơ sở: <b>${brName}</b>\n`
            + `👤 Khách: <b>${item.name}</b> (${item.phone || ''})\n`
            + `📌 Trạng thái: <b>${stText}</b>`;
          sendTelegramToBranch(br, msg);
        }
      }
    }

    if (col === 'queue' && data && !isDelete && (!oldDoc || !oldDoc.exists)) {
      const br = data.br || 'b1';
      const brName = getBranchName(br);
      const msg = `⏳ <b>KHÁCH VÀO HÀNG CHỜ PHÒNG</b>\n`
        + `🏢 Cơ sở: <b>${brName}</b>\n`
        + `👤 Khách: <b>${data.name}</b> (${data.phone || 'Không SĐT'}) - ${data.people || 1} người`;
      sendTelegramToBranch(br, msg);
    }
  }

  // 3. THÔNG BÁO KIỂM SOÁT VẬN HÀNH & KÉT TIỀN CHO QUẢN LÝ (logs, cashmv, shifts)
  if (notify.control !== false) {
    if (col === 'logs' && data && !isDelete) {
      const br = data.br || 'b1';
      const brName = getBranchName(br);
      const msg = `🛡️ <b>KIỂM SOÁT VẬN HÀNH</b>\n`
        + `🏢 Cơ sở: <b>${brName}</b>\n`
        + `👤 Thực hiện: <b>${data.name || 'Hệ thống'}</b>\n`
        + `📝 Thao tác: ${data.act || ''}`;
      sendTelegramToBranch(br, msg);
    }

    if (col === 'cashmv' && data && !isDelete && (!oldDoc || !oldDoc.exists)) {
      const br = data.br || 'b1';
      const brName = getBranchName(br);
      const loai = data.type === 'in' ? 'NẠP TIỀN VÀO KÉT (+)' : 'CHI TIỀN TỪ KÉT (-)';
      const msg = `🏦 <b>BIẾN ĐỘNG KÉT TIỀN</b>\n`
        + `🏢 Cơ sở: <b>${brName}</b>\n`
        + `📌 Loại: <b>${loai}</b>\n`
        + `💵 Số tiền: <b>${fmtMoney(data.amount)}</b>\n`
        + `📝 Lý do: ${data.note || 'Không ghi chú'}\n`
        + `👤 Người tạo: ${data.name || 'Nhân viên'}`;
      sendTelegramToBranch(br, msg);
    }
  }
}

// --- HỆ THỐNG XÁC THỰC OTP TELEGRAM THEO SỐ ĐIỆN THOẠI ---
const otpStore = new Map();     // phone -> { code, expires, adminEntry }
const adminTokens = new Map();  // token -> { phone, name, branch, expires }

app.post('/api/admin/send-otp', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone || phone.length < 9) {
    return res.json({ ok: false, msg: 'Số điện thoại không hợp lệ!' });
  }

  const cfg = getConfig();
  const botToken = String(cfg.telegramBotToken || '').trim();
  const admins = Array.isArray(cfg.admins) ? cfg.admins : [];

  const isDefaultConfig = !botToken || botToken === 'DAN_MA_BOT_TOKEN_VAO_DAY';
  const adminEntry = admins.find(a => normalizePhone(a.phone) === phone);

  if (!isDefaultConfig && !adminEntry) {
    return res.json({ ok: false, msg: 'Số điện thoại này chưa được cấp quyền Quản lý!' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { code, expires: Date.now() + 5 * 60 * 1000, adminEntry });

  const chatId = adminEntry ? String(adminEntry.telegramChatId || '').trim() : '';
  if (isDefaultConfig || !chatId || chatId.startsWith('DAN_CHAT_ID')) {
    console.log(`[OTP CHẠY THỬ] Mã OTP cho SĐT ${phone} là: ${code}`);
    return res.json({ ok: true, devOtp: code });
  }

  try {
    const brLabel = adminEntry.branch === 'all' ? 'Tất cả cơ sở' : getBranchName(adminEntry.branch);
    const text = `🔐 <b>MÃ OTP ĐĂNG NHẬP QUẢN LÝ</b>\n\n`
      + `👤 Quản lý: <b>${adminEntry.name || phone}</b>\n`
      + `🏢 Phạm vi: <b>${brLabel}</b>\n`
      + `🔑 Mã OTP của bạn: <b><code>${code}</code></b>\n\n`
      + `<i>(Mã có hiệu lực trong 5 phút)</i>`;
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const tgData = await tgRes.json();
    if (!tgData.ok) {
      console.error('Lỗi Telegram API:', tgData.description);
      return res.json({ ok: false, msg: 'Lỗi Telegram: ' + (tgData.description || 'Không gửi được tin nhắn') });
    }
    console.log(`[OTP TELEGRAM] Đã gửi mã OTP cho SĐT ${phone}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Lỗi kết nối Telegram:', err.message);
    res.json({ ok: false, msg: 'Lỗi kết nối Telegram: ' + err.message });
  }
});

app.post('/api/admin/verify-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || '').trim();
  const record = otpStore.get(phone);

  if (!record) return res.json({ ok: false, msg: 'Vui lòng bấm nhận mã OTP trước' });
  if (Date.now() > record.expires) {
    otpStore.delete(phone);
    return res.json({ ok: false, msg: 'Mã OTP đã hết hạn (quá 5 phút), vui lòng lấy mã mới' });
  }
  if (record.code !== otp) return res.json({ ok: false, msg: 'Mã OTP không chính xác' });

  otpStore.delete(phone);
  const adm = record.adminEntry || {};
  const token = crypto.randomBytes(24).toString('hex');
  const sessionInfo = {
    phone,
    name: adm.name || phone,
    branch: adm.branch || 'all',
    expires: Date.now() + 24 * 60 * 60 * 1000
  };
  adminTokens.set(token, sessionInfo);
  res.json({ ok: true, token, phone: sessionInfo.phone, name: sessionInfo.name, branch: sessionInfo.branch });
});

app.post('/api/admin/check-session', (req, res) => {
  const token = String(req.body.token || '');
  const sess = adminTokens.get(token);
  if (!sess || Date.now() > sess.expires) {
    adminTokens.delete(token);
    return res.json({ ok: false });
  }
  res.json({ ok: true, phone: sess.phone, name: sess.name, branch: sess.branch });
});

// --- TRA CỨU ĐƠN ĐẶT PHÒNG THEO SỐ ĐIỆN THOẠI KHÁCH HÀNG ---
app.get('/api/public/bookings/lookup', (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone || phone.length < 9) {
    return res.json({ ok: false, msg: 'Vui lòng nhập số điện thoại hợp lệ (ít nhất 9 số)' });
  }
  const allDocs = dbAdapter.getCol('bookings');
  const results = [];
  for (const doc of allDocs) {
    const items = (doc.data && Array.isArray(doc.data.items)) ? doc.data.items : [];
    for (const item of items) {
      if (normalizePhone(item.phone) === phone) {
        results.push({ ...item, owner: doc.id });
      }
    }
  }
  results.sort((a, b) => (b.created || 0) - (a.created || 0));
  res.json({ ok: true, phone, items: results });
});

// --- REST API DỮ LIỆU ---
app.get('/api/col/:col', (req, res) => {
  res.json({ docs: dbAdapter.getCol(req.params.col) });
});

app.get('/api/doc/:col/:id', (req, res) => {
  res.json(dbAdapter.getDoc(req.params.col, req.params.id));
});

app.post('/api/doc/:col/:id', (req, res) => {
  const { col, id } = req.params;
  const oldDoc = dbAdapter.getDoc(col, id);
  if (col === 'display' && req.body && req.body.status === 'idle' && oldDoc.exists && oldDoc.data
      && oldDoc.data.status === 'paid' && Date.now() - Number(oldDoc.data.paidAt || 0) < 8000) {
    return res.json({ ok: true, id, kept: true }); // giữ màn "Đã thanh toán" cho khách xem
  }
  dbAdapter.setDoc(col, id, req.body);
  io.emit('db_change', { col, id });
  handleTelegramEvent(col, id, req.body, oldDoc, false);
  res.json({ ok: true, id });
});

app.post('/api/col/:col', (req, res) => {
  const { col } = req.params;
  const id = 'a' + Date.now() + Math.random().toString(36).slice(2, 6);
  dbAdapter.setDoc(col, id, req.body);
  io.emit('db_change', { col, id });
  handleTelegramEvent(col, id, req.body, null, false);
  res.json({ ok: true, id });
});

app.delete('/api/doc/:col/:id', (req, res) => {
  const { col, id } = req.params;
  const oldDoc = dbAdapter.getDoc(col, id);
  dbAdapter.delDoc(col, id);
  io.emit('db_change', { col, id });
  handleTelegramEvent(col, id, null, oldDoc, true);
  res.json({ ok: true });
});

// --- VÒNG QUAY MAY MẮN ---
const os = require('os');
const WHEEL_COLORS = ['#d4366b', '#7c3aed', '#f59e0b', '#0ea5e9', '#10b981', '#ef4444', '#8b5cf6', '#14b8a6'];
const WHEEL_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const wheelIpCount = new Map(); // ip|ngày -> số lượt quay

function wheelDefault() {
  return {
    on: false, title: 'Vòng quay may mắn', validDays: 14, perPhoneDay: 1, dailyMaxWins: 0, brScope: 'same', baseUrl: '',
    prizes: [
      { id: 'w1', label: 'Giảm 5%', type: 'pct', val: 5, maxDisc: 0, minOrder: 0, weight: 35 },
      { id: 'w2', label: 'Giảm 10%', type: 'pct', val: 10, maxDisc: 0, minOrder: 0, weight: 20 },
      { id: 'w3', label: 'Giảm 15%', type: 'pct', val: 15, maxDisc: 0, minOrder: 0, weight: 10 },
      { id: 'w4', label: 'Giảm 20%', type: 'pct', val: 20, maxDisc: 0, minOrder: 0, weight: 5 },
      { id: 'w5', label: 'Giảm 30.000đ', type: 'amt', val: 30000, maxDisc: 0, minOrder: 0, weight: 10 },
      { id: 'w6', label: 'Chúc may mắn lần sau', type: 'none', val: 0, maxDisc: 0, minOrder: 0, weight: 20 }
    ]
  };
}
function getWheel() {
  const site = dbAdapter.getDoc('site', 'config');
  const w = site.exists && site.data && site.data.wheel;
  return w && Array.isArray(w.prizes) ? { ...wheelDefault(), ...w } : wheelDefault();
}
function vnDay(t) {
  const d = new Date((t || Date.now()) + 7 * 3600 * 1000); // giờ Việt Nam
  return d.toISOString().slice(0, 10);
}
function lanUrl() {
  const nets = os.networkInterfaces();
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) return `http://${n.address}:${process.env.PORT || 3000}`;
    }
  }
  return '';
}
function wheelCode() {
  for (let t = 0; t < 20; t++) {
    let c = 'Q';
    for (let i = 0; i < 6; i++) c += WHEEL_ALPHA[crypto.randomInt(WHEEL_ALPHA.length)];
    if (!dbAdapter.getDoc('wheelwins', c).exists) return c;
  }
  return 'Q' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

app.get('/api/wheel/config', (req, res) => {
  const w = getWheel();
  const site = dbAdapter.getDoc('site', 'config');
  const brand = (site.exists && site.data && site.data.brand) || 'Karaoke';
  res.json({
    ok: true, on: !!w.on, title: w.title || 'Vòng quay may mắn', brand,
    validDays: w.validDays, perPhoneDay: w.perPhoneDay,
    prizes: w.prizes.map((p, i) => ({ label: p.label, type: p.type, color: WHEEL_COLORS[i % WHEEL_COLORS.length] })),
    baseUrl: String(w.baseUrl || '').replace(/\/+$/, ''), lanUrl: lanUrl()
  });
});

app.post('/api/wheel/spin', (req, res) => {
  const w = getWheel();
  if (!w.on) return res.json({ ok: false, msg: 'Vòng quay hiện chưa mở' });
  const phone = normalizePhone(req.body.phone);
  if (!/^0\d{9}$/.test(phone)) return res.json({ ok: false, msg: 'Vui lòng nhập số điện thoại 10 số' });
  const br = String(req.body.br || 'b1').slice(0, 20);
  const room = String(req.body.room || '').slice(0, 40);
  const billNo = String(req.body.billNo || '').slice(0, 40);
  const day = vnDay();

  const ipKey = (req.headers['cf-connecting-ip'] || req.ip || '') + '|' + day;
  const ipN = wheelIpCount.get(ipKey) || 0;
  if (ipN >= 10) return res.json({ ok: false, msg: 'Thiết bị này đã quay quá nhiều lần hôm nay' });

  const all = dbAdapter.getCol('wheelwins').map(r => r.data).filter(Boolean);
  const todayMine = all.filter(x => x.phone === phone && vnDay(x.created) === day).length;
  const perDay = Math.max(1, Number(w.perPhoneDay) || 1);
  if (todayMine >= perDay) return res.json({ ok: false, msg: `Số điện thoại này đã dùng hết ${perDay} lượt quay hôm nay. Hẹn bạn ngày mai!` });

  const wonToday = all.filter(x => x.code && vnDay(x.created) === day).length;
  const capReached = Number(w.dailyMaxWins) > 0 && wonToday >= Number(w.dailyMaxWins);

  // chọn giải theo tỉ trọng (hết ngân sách trong ngày thì chỉ rơi vào ô "không trúng")
  let pool = w.prizes.map((p, i) => ({ p, i, wt: Math.max(0, Number(p.weight) || 0) }));
  if (capReached) pool = pool.filter(x => x.p.type === 'none');
  let total = pool.reduce((s, x) => s + x.wt, 0);
  if (total <= 0) return res.json({ ok: false, msg: 'Vòng quay đang bảo trì, vui lòng thử lại sau' });
  let r = crypto.randomInt(Math.round(total * 1000)) / 1000, pick = pool[pool.length - 1];
  for (const x of pool) { if (r < x.wt) { pick = x; break; } r -= x.wt; }

  const prize = pick.p;
  const now = Date.now();
  wheelIpCount.set(ipKey, ipN + 1);
  let doc, id;
  if (prize.type === 'none') {
    id = 'n' + crypto.randomBytes(5).toString('hex');
    doc = { code: '', phone, br, label: prize.label, created: now, none: true };
  } else {
    id = wheelCode();
    const expMs = now + Math.max(1, Number(w.validDays) || 14) * 86400000;
    doc = {
      code: id, phone, br: w.brScope === 'all' ? 'all' : br, room, billNo, label: prize.label,
      discType: prize.type, discVal: Number(prize.val) || 0, maxDisc: Number(prize.maxDisc) || 0,
      minOrder: Number(prize.minOrder) || 0, scope: 'all',
      exp: vnDay(expMs), used: false, created: now
    };
  }
  dbAdapter.setDoc('wheelwins', id, doc);
  io.emit('db_change', { col: 'wheelwins', id });
  if (doc.code) io.emit('wheel_won', doc);
  res.json({ ok: true, index: pick.i, label: prize.label, type: prize.type, code: doc.code, exp: doc.exp || '', minOrder: doc.minOrder || 0, maxDisc: doc.maxDisc || 0, left: perDay - todayMine - 1 });
});

app.get('/api/wheel/code/:code', (req, res) => {
  const ipKey = 'chk|' + (req.headers['cf-connecting-ip'] || req.ip || '');
  const n = (wheelIpCount.get(ipKey) || 0) + 1;
  wheelIpCount.set(ipKey, n);
  if (n > 60) return res.json({ ok: false, msg: 'Bạn thử quá nhiều lần, vui lòng quay lại sau' });
  const code = String(req.params.code || '').trim().toUpperCase();
  const d = dbAdapter.getDoc('wheelwins', code);
  if (!d.exists || !d.data.code) return res.json({ ok: false, msg: 'Không tìm thấy mã này' });
  const x = d.data;
  const status = x.used ? 'used' : (x.exp && x.exp < vnDay() ? 'expired' : 'valid');
  res.json({ ok: true, code: x.code, label: x.label, exp: x.exp, minOrder: x.minOrder || 0, status });
});


// --- HỆ THỐNG CHẤM CÔNG KHUÔN MẶT AI (FACE RECOGNITION) ---
function faceDistance(d1, d2) {
  if (!Array.isArray(d1) || !Array.isArray(d2) || d1.length !== d2.length) return 999;
  let sum = 0;
  for (let i = 0; i < d1.length; i++) {
    const diff = Number(d1[i]) - Number(d2[i]);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// 1. Lấy danh sách nhân viên active & dữ liệu khuôn mặt mẫu
app.get('/api/attendance/staff', (req, res) => {
  const br = String(req.query.br || '');
  const list = dbAdapter.getCol('staff')
    .map(r => r.data)
    .filter(s => s && s.status !== 'inactive' && (!br || !s.branch || s.branch === 'all' || s.branch === br))
    .map(s => ({
      id: s.id,
      name: s.name,
      pos: s.pos || 'Nhân viên',
      branch: s.branch || 'b1',
      hasFace: Array.isArray(s.faceDescriptors) && s.faceDescriptors.length > 0,
      faceDescriptors: Array.isArray(s.faceDescriptors) ? s.faceDescriptors : []
    }));
  res.json({ ok: true, staff: list });
});

// 2. Đăng ký khuôn mặt mẫu cho nhân viên (xác thực bằng PIN nhân viên hoặc mật khẩu/OTP quản lý)
app.post('/api/attendance/enroll', (req, res) => {
  const { staffId, pin, descriptors } = req.body || {};
  if (!staffId || !Array.isArray(descriptors) || descriptors.length === 0) {
    return res.json({ ok: false, msg: 'Thiếu dữ liệu khuôn mặt hoặc chưa chọn nhân viên!' });
  }
  const doc = dbAdapter.getDoc('staff', staffId);
  if (!doc.exists || !doc.data) {
    return res.json({ ok: false, msg: 'Không tìm thấy hồ sơ nhân viên!' });
  }
  const st = doc.data;
  // Kiểm tra mã PIN nhân viên (hoặc cho phép nếu quản lý nhập mã mặc định 9999 / đúng PIN)
  const inputPin = String(pin || '').trim();
  const validHash = crypto.createHash('sha256').update(`${st.salt || 'demo'}:${inputPin}`).digest('hex');
  if (inputPin !== '9999' && validHash !== st.hash) {
    return res.json({ ok: false, msg: 'Mã PIN xác thực không chính xác!' });
  }

  // Giữ tối đa 3 góc mặt mẫu gần nhất để nhận diện chính xác
  const prev = Array.isArray(st.faceDescriptors) ? st.faceDescriptors : [];
  const nextDescriptors = [...prev, ...descriptors].slice(-3);
  const updated = { ...st, faceDescriptors: nextDescriptors, faceUpdatedAt: Date.now() };
  dbAdapter.setDoc('staff', staffId, updated);
  io.emit('db_change', { col: 'staff', id: staffId });
  res.json({ ok: true, name: st.name, count: nextDescriptors.length });
});

// 3. Ghi nhận chấm công vào ca / tan ca bằng khuôn mặt
app.post('/api/attendance/checkin', (req, res) => {
  const { staffId, descriptor, br, photo } = req.body || {};
  if (!staffId || !Array.isArray(descriptor)) {
    return res.json({ ok: false, msg: 'Dữ liệu nhận diện không hợp lệ!' });
  }
  const doc = dbAdapter.getDoc('staff', staffId);
  if (!doc.exists || !doc.data) {
    return res.json({ ok: false, msg: 'Không tìm thấy nhân viên!' });
  }
  const st = doc.data;
  const saved = Array.isArray(st.faceDescriptors) ? st.faceDescriptors : [];
  if (!saved.length) {
    return res.json({ ok: false, msg: 'Nhân viên này chưa đăng ký khuôn mặt mẫu!' });
  }

  // Đối chiếu lại khoảng cách vector trên server để chống giả mạo
  let minDist = 999;
  for (const d of saved) {
    const dist = faceDistance(descriptor, d);
    if (dist < minDist) minDist = dist;
  }
  if (minDist > 0.52) {
    return res.json({ ok: false, msg: 'Khuôn mặt không khớp với hồ sơ (' + minDist.toFixed(2) + ')' });
  }

  const now = Date.now();
  const day = vnDay(now);
  const branchId = br || st.branch || 'b1';

  // Chống bấm nhầm 2 lần liên tiếp trong vòng 2 phút
  const allAtt = dbAdapter.getCol('attendance').map(r => r.data).filter(Boolean);
  const mineToday = allAtt
    .filter(a => a.staffId === staffId && a.day === day)
    .sort((a, b) => (a.time || 0) - (b.time || 0));

  const lastRec = mineToday[mineToday.length - 1];
  if (lastRec && (now - Number(lastRec.time || 0)) < 120000) {
    const waitSec = Math.ceil((120000 - (now - Number(lastRec.time || 0))) / 1000);
    return res.json({ ok: false, msg: `${st.name} vừa chấm công xong! Vui lòng đợi ${waitSec}s nếu muốn thao tác lại.` });
  }

  // Tự động xác định: chưa vào ca (hoặc đã tan ca trước đó) -> Vào ca (in); đang trong ca -> Tan ca (out)
  const action = (!lastRec || lastRec.action === 'out') ? 'in' : 'out';
  let workedMins = 0;
  if (action === 'out' && lastRec && lastRec.time) {
    workedMins = Math.max(1, Math.round((now - Number(lastRec.time)) / 60000));
  }

  const recId = 'att_' + now + '_' + Math.random().toString(36).slice(2, 5);
  const record = {
    id: recId,
    staffId,
    staffName: st.name,
    pos: st.pos || 'Nhân viên',
    br: branchId,
    day,
    action,
    time: now,
    workedMins,
    distance: Number(minDist.toFixed(3)),
    photo: typeof photo === 'string' && photo.startsWith('data:image/') ? photo.slice(0, 120000) : ''
  };
  dbAdapter.setDoc('attendance', recId, record);
  io.emit('db_change', { col: 'attendance', id: recId });

  // Gửi thông báo về Telegram cho Quản lý cơ sở
  const timeStr = new Date(now + 7 * 3600 * 1000).toISOString().slice(11, 16);
  const brName = getBranchName(branchId);
  const actLabel = action === 'in' ? '🟢 VÀO CA (CHECK-IN)' : '🔴 TAN CA (CHECK-OUT)';
  const durText = action === 'out'
    ? `
⏱️ Thời gian làm ca: <b>${Math.floor(workedMins / 60)} giờ ${workedMins % 60} phút</b>`
    : '';
  const tgMsg = `📸 <b>CHẤM CÔNG KHUÔN MẶT</b>
`
    + `🏢 Cơ sở: <b>${brName}</b>
`
    + `👤 Nhân viên: <b>${st.name}</b> (${st.pos || 'NV'})
`
    + `📌 Trạng thái: <b>${actLabel}</b> lúc <b>${timeStr}</b>${durText}`;
  sendTelegramToBranch(branchId, tgMsg);

  res.json({
    ok: true,
    action,
    staffName: st.name,
    timeStr,
    workedMins
  });
});

// --- ĐỊNH TUYẾN 3 TRANG TÁCH BIỆT ---
const indexHtml = path.join(__dirname, 'public', 'index.html');
app.get(['/', '/khach', '/nhan-vien', '/quan-ly'], (req, res) => {
  res.sendFile(indexHtml);
});
app.get('/man-hinh-khach', (req, res) => res.sendFile(path.join(__dirname, 'public', 'man-hinh-khach.html')));
app.get('/vong-quay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vong-quay.html')));
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('Thiết bị kết nối:', socket.id);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('===================================================================');
  console.log('KARAOKE MANAGER v2.2 - PHÂN QUYỀN CƠ SỞ & THÔNG BÁO TELEGRAM');
  console.log(`- Trang Khách hàng : http://localhost:${PORT}/khach`);
  console.log(`- Trang Nhân viên  : http://localhost:${PORT}/nhan-vien`);
  console.log(`- Trang Quản lý    : http://localhost:${PORT}/quan-ly`);
  console.log(`- Màn hình khách   : http://localhost:${PORT}/man-hinh-khach?br=b1`);
  console.log(`- Vòng quay        : http://localhost:${PORT}/vong-quay?br=b1`);
  console.log(`- Database         : ${dbAdapter.type}`);
  console.log('===================================================================');
});
