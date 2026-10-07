/**
 * FRDR Garage — Script Otomatis Rekap Tutup Kasir Harian Cloud (EOD Cron)
 * Berjalan otomatis di GitHub Actions (Jam 23:59 WIB) tanpa butuh komputer bengkel menyala.
 * File: scripts/cron_daily_eod.js
 */

const https = require('https');

const FIREBASE_API_KEY = "AIzaSyArvWKgTasNsqbtA_9JOJWv6CPvKVOQfhU";
const FIREBASE_PROJECT_ID = "kasir-bengkel-b1265";

function request(url, options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function formatRp(num) {
  return 'Rp ' + Number(num || 0).toLocaleString('id-ID');
}

function formatIndoDate(dateStr) {
  if (!dateStr) return '-';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Helper konversi format dokumen Firestore REST ke Object JS biasa
function parseFirestoreDoc(fields) {
  if (!fields) return {};
  const res = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val.stringValue !== undefined) res[key] = val.stringValue;
    else if (val.integerValue !== undefined) res[key] = parseInt(val.integerValue, 10);
    else if (val.doubleValue !== undefined) res[key] = parseFloat(val.doubleValue);
    else if (val.booleanValue !== undefined) res[key] = val.booleanValue;
    else if (val.nullValue !== undefined) res[key] = null;
    else if (val.arrayValue !== undefined) {
      res[key] = (val.arrayValue.values || []).map(v => {
        if (v.mapValue) return parseFirestoreDoc(v.mapValue.fields);
        if (v.stringValue !== undefined) return v.stringValue;
        if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
        return v;
      });
    } else if (val.mapValue !== undefined) {
      res[key] = parseFirestoreDoc(val.mapValue.fields);
    }
  }
  return res;
}

// Dapatkan tanggal hari ini dalam zona waktu Waktu Indonesia Barat (WIB, UTC+7)
function getTodayDateWib() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const wibDate = new Date(utc + (7 * 3600000)); // UTC + 7 jam
  const y = wibDate.getFullYear();
  const m = String(wibDate.getMonth() + 1).padStart(2, '0');
  const d = String(wibDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function runCronEOD() {
  console.log('================================================================');
  console.log('🚀 CLOUD CRON: REKAP TUTUP KASIR HARIAN FRDR GARAGE (23:59 WIB)');
  console.log('================================================================\n');

  // 1. Otentikasi Anonim ke Firebase
  console.log('⏳ [1/5] Otentikasi Cloud ke Firebase Firestore...');
  const authRes = await request(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({ returnSecureToken: true }));

  if (!authRes.idToken) {
    throw new Error('Gagal mendapatkan auth token: ' + JSON.stringify(authRes));
  }
  const idToken = authRes.idToken;
  console.log('✅ [1/5] Terhubung ke Firebase Cloud.\n');

  // 2. Ambil Profil Bengkel & Pengaturan Telegram
  console.log('⏳ [2/5] Membaca konfigurasi profil bengkel...');
  const shopDoc = await request(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/meta/shopInfo`, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + idToken }
  });

  const shopInfo = parseFirestoreDoc(shopDoc.fields || {});
  const shopName = shopInfo.name || 'FRDR GARAGE';
  const token = shopInfo.telegramBotToken ? shopInfo.telegramBotToken.trim() : '';
  const chatId = shopInfo.telegramChatId ? shopInfo.telegramChatId.trim() : '';
  const autoActive = (shopInfo.telegramAutoEod !== false);

  console.log(`🏢 Nama Toko        : ${shopName}`);
  console.log(`🤖 Bot Telegram     : ${token ? 'Terkonfigurasi' : 'Belum diatur'}`);
  console.log(`💬 ID Chat Telegram : ${chatId || 'Belum diatur'}`);
  console.log(`⚙️ Auto EOD Status  : ${autoActive ? 'AKTIF' : 'NONAKTIF'}`);

  if (!token || !chatId) {
    console.warn('⚠️ Token Bot atau Chat ID Telegram belum diatur. Proses dihentikan.');
    return;
  }

  if (!autoActive) {
    console.log('ℹ️ Pengaturan Auto EOD Telegram dinonaktifkan oleh pengguna di Profil Toko. Lewati.');
    return;
  }
  console.log('✅ [2/5] Konfigurasi siap.\n');

  // 3. Tentukan Rentang Waktu Hari Ini (WIB)
  const targetDateStr = process.env.TARGET_DATE || getTodayDateWib();
  console.log(`⏳ [3/5] Mengambil data transaksi untuk tanggal: ${targetDateStr} (WIB)...`);

  // Timestamp WIB: 00:00:00 WIB = 17:00:00 UTC kemarin, 23:59:59 WIB = 16:59:59 UTC hari ini
  const startOfDayWib = new Date(targetDateStr + 'T00:00:00+07:00').getTime();
  const endOfDayWib = new Date(targetDateStr + 'T23:59:59+07:00').getTime();

  // 4. Ambil Koleksi Transaksi
  let allTxs = [];
  try {
    let pageToken = '';
    do {
      const pageUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/transactions?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
      const res = await request(pageUrl, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + idToken }
      });
      if (res.documents && Array.isArray(res.documents)) {
        res.documents.forEach(d => {
          allTxs.push(parseFirestoreDoc(d.fields));
        });
      }
      pageToken = res.nextPageToken || '';
    } while (pageToken);
  } catch (txErr) {
    console.warn('Gagal memuat transactions:', txErr);
  }

  // Filter transaksi hari ini yang tidak dibatalkan
  const todayTxs = allTxs.filter(tx => {
    if (tx.status === 'batal') return false;
    const t = tx.timestamp || 0;
    return t >= startOfDayWib && t <= endOfDayWib;
  });

  // 5. Ambil Koleksi Pengeluaran (Expenses)
  let todayExpenses = [];
  try {
    const expRes = await request(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/expenses?pageSize=300`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + idToken }
    });
    if (expRes.documents && Array.isArray(expRes.documents)) {
      expRes.documents.forEach(d => {
        const ex = parseFirestoreDoc(d.fields);
        const exDate = (ex.date || '').slice(0, 10);
        if (exDate === targetDateStr) todayExpenses.push(ex);
      });
    }
  } catch (e) {
    console.warn('Gagal memuat expenses:', e);
  }

  // 6. Ambil Koleksi Pemasukan Tambahan (Additional Incomes)
  let todayIncomes = [];
  try {
    const incRes = await request(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/additionalIncomes?pageSize=300`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + idToken }
    });
    if (incRes.documents && Array.isArray(incRes.documents)) {
      incRes.documents.forEach(d => {
        const inc = parseFirestoreDoc(d.fields);
        const incDate = (inc.date || '').slice(0, 10);
        if (incDate === targetDateStr) todayIncomes.push(inc);
      });
    }
  } catch (e) {
    console.warn('Gagal memuat additionalIncomes:', e);
  }

  // 7. Kalkulasi Rekap Pembukuan
  let totalOmzet = 0;
  let totalCash = 0;
  let totalQris = 0;
  let totalTransfer = 0;
  let omzetPart = 0;
  let omzetJasa = 0;
  const platesSet = new Set();
  const itemSoldMap = {};

  todayTxs.forEach(tx => {
    totalOmzet += (tx.total || 0);
    const paid = tx.paid != null ? tx.paid : tx.total;
    const pm = (tx.paymentMethod || 'cash').toLowerCase();

    if (pm === 'qris') totalQris += paid;
    else if (pm === 'transfer') totalTransfer += paid;
    else totalCash += paid;

    if (tx.vehiclePlate) platesSet.add(tx.vehiclePlate.trim().toUpperCase());

    (tx.items || []).forEach(it => {
      const lineTot = (it.price || 0) * (it.qty || 1);
      if (it.type === 'jasa') {
        omzetJasa += lineTot;
      } else {
        omzetPart += lineTot;
        const name = it.name || 'Part';
        itemSoldMap[name] = (itemSoldMap[name] || 0) + (it.qty || 1);
      }
    });
  });

  let totalExpenses = 0;
  let cashExpenses = 0;
  todayExpenses.forEach(ex => {
    const amt = parseFloat(ex.amount) || 0;
    totalExpenses += amt;
    if ((ex.paymentMethod || 'cash').toLowerCase() === 'cash') {
      cashExpenses += amt;
    }
  });

  let totalAddIncomes = 0;
  let cashAddIncomes = 0;
  todayIncomes.forEach(inc => {
    const amt = parseFloat(inc.amount) || 0;
    totalAddIncomes += amt;
    if ((inc.paymentMethod || 'cash').toLowerCase() === 'cash') {
      cashAddIncomes += amt;
    }
  });

  const cashInDrawer = (totalCash + cashAddIncomes) - cashExpenses;

  const topParts = Object.entries(itemSoldMap)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, qty]) => `${name} (${qty}x)`);

  console.log(`📊 Hasil Pembukuan:`);
  console.log(`   - Transaksi Kasir : ${todayTxs.length}`);
  console.log(`   - Total Omzet     : ${formatRp(totalOmzet)}`);
  console.log(`   - Tunai (Cash)    : ${formatRp(totalCash)}`);
  console.log(`   - QRIS            : ${formatRp(totalQris)}`);
  console.log(`   - Transfer        : ${formatRp(totalTransfer)}`);
  console.log(`   - Estimasi Laci   : ${formatRp(cashInDrawer)}`);
  console.log('✅ [3/5] Pembukuan berhasil dihitung.\n');

  // 8. Susun Pesan Laporan HTML untuk Bot Telegram
  console.log('⏳ [4/5] Merangkai pesan laporan Telegram...');
  const dateFormatted = formatIndoDate(targetDateStr);

  let msg = `📊 <b>REKAP TUTUP KASIR HARIAN — ${shopName.toUpperCase()}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📅 <b>Tanggal:</b> ${dateFormatted}\n`;
  msg += `⏰ <b>Waktu:</b> 23:59 WIB (Otomatis Cloud)\n\n`;

  msg += `💰 <b>TOTAL OMZET:</b> <b>${formatRp(totalOmzet)}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💵 <b>Uang Tunai (Cash):</b> ${formatRp(totalCash)}\n`;
  msg += `📱 <b>QRIS:</b> ${formatRp(totalQris)}\n`;
  msg += `🏦 <b>Transfer Bank:</b> ${formatRp(totalTransfer)}\n\n`;

  msg += `📦 <b>Omzet Sparepart:</b> ${formatRp(omzetPart)}\n`;
  msg += `🔧 <b>Omzet Jasa Servis:</b> ${formatRp(omzetJasa)}\n`;
  if (totalAddIncomes > 0) {
    msg += `➕ <b>Pemasukan Lain:</b> ${formatRp(totalAddIncomes)}\n`;
  }
  msg += `📉 <b>Pengeluaran Kas Kecil:</b> ${formatRp(totalExpenses)}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💵 <b>ESTIMASI KAS FISIK DI LACI:</b> <b>${formatRp(cashInDrawer)}</b>\n`;
  msg += `<i>(Tunai Penjualan + Pemasukan Tunai - Pengeluaran Tunai)</i>\n\n`;

  msg += `📋 <b>Total Transaksi Kasir:</b> ${todayTxs.length} Transaksi\n`;
  msg += `🏍️ <b>Unit Kendaraan Dilayani:</b> ${platesSet.size} Kendaraan\n`;

  if (topParts && topParts.length > 0) {
    msg += `🏆 <b>Part Terlaris:</b> ${topParts.join(', ')}\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🤖 <i>Laporan tutup kasir otomatis 23:59 WIB (Cloud Server GitHub Actions).</i>`;

  // 9. Kirim ke Telegram API
  console.log('⏳ [5/5] Mengirim laporan ke Bot Telegram...');
  const payload = JSON.stringify({
    chat_id: chatId,
    text: msg,
    parse_mode: 'HTML'
  });

  const tgRes = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  console.log('----------------------------------------------------------------');
  if (tgRes && tgRes.ok) {
    console.log('🎉 SUKSES 100%! LAPORAN EOD CLOUD BERHASIL DIKIRIM KE TELEGRAM!');
    console.log(`📩 ID Pesan Telegram : ${tgRes.result.message_id}`);
    console.log(`👥 Tujuan Chat/Grup  : "${tgRes.result.chat.title || tgRes.result.chat.first_name}" (ID: ${tgRes.result.chat.id})`);
    console.log('----------------------------------------------------------------');
  } else {
    console.error('❌ Gagal mengirim ke Telegram:', tgRes);
  }
}

runCronEOD().catch(err => {
  console.error('❌ Fatal error dalam cron EOD:', err);
  process.exit(1);
});
