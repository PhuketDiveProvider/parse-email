const { sql } = require('@vercel/postgres');

function getBangkokDateRange(period) {
  // Returns [startDate, endDate] in YYYY-MM-DD for the given period in Bangkok time
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const bangkok = new Date(utc + 7 * 60 * 60 * 1000);
  let start, end;
  if (period === 'all') {
    start = '1970-01-01';
    end = '2100-01-01';
  } else if (period === 'lastMonth') {
    // Last month in Bangkok time
    const firstOfThisMonth = new Date(bangkok.getFullYear(), bangkok.getMonth(), 1);
    const firstOfLastMonth = new Date(bangkok.getFullYear(), bangkok.getMonth() - 1, 1);
    start = firstOfLastMonth.toISOString().slice(0, 10);
    end = firstOfThisMonth.toISOString().slice(0, 10);
  } else {
    // This month (default)
    const firstOfThisMonth = new Date(bangkok.getFullYear(), bangkok.getMonth(), 1);
    const firstOfNextMonth = new Date(bangkok.getFullYear(), bangkok.getMonth() + 1, 1);
    start = firstOfThisMonth.toISOString().slice(0, 10);
    end = firstOfNextMonth.toISOString().slice(0, 10);
  }
  return [start, end];
}

module.exports = async (req, res) => {
  const period = req.query.period || 'thisMonth'; // 'thisMonth', 'lastMonth', 'all'
  const [start, end] = getBangkokDateRange(period);
  console.log('[DEBUG] Dashboard API called:', { period, start, end });
  try {
    // Total bookings (by tour_date, filtered by period)
    const { rows: totalRows } = await sql.query(
      `SELECT COUNT(*) AS count FROM bookings WHERE tour_date >= $1 AND tour_date < $2`, [start, end]
    );
    const totalBookings = parseInt(totalRows[0].count, 10);
    console.log('[DEBUG] Total bookings:', totalBookings);

    // New Bookings and Booked: all bookings with tour_date in period
    const newBookings = totalBookings;
    const booked = totalBookings;

    // Done: bookings with tour_date in period and customer=TRUE
    const { rows: doneRows } = await sql.query(
      `SELECT COUNT(*) AS count FROM bookings WHERE tour_date >= $1 AND tour_date < $2 AND customer = TRUE`, [start, end]
    );
    const done = parseInt(doneRows[0].count, 10);
    console.log('[DEBUG] Done:', done, 'Booked:', booked, 'New Bookings:', newBookings);

    // Total earnings (sum of paid)
    const { rows: paidRows } = await sql.query(
      `SELECT COALESCE(SUM(paid),0) AS sum FROM bookings WHERE tour_date >= $1 AND tour_date < $2`, [start, end]
    );
    const totalEarnings = parseFloat(paidRows[0].sum);
    console.log('[DEBUG] Total earnings:', totalEarnings);

    // Revenue by day (for chart)
    const { rows: revenueRows } = await sql.query(
      `SELECT tour_date::date AS day, COALESCE(SUM(paid),0) AS revenue, COUNT(*) AS count
       FROM bookings WHERE tour_date >= $1 AND tour_date < $2
       GROUP BY day ORDER BY day`, [start, end]
    );
    console.log('[DEBUG] Revenue by day:', revenueRows.length);
    // Top destinations (by program)
    const { rows: destRows } = await sql.query(
      `SELECT program, COUNT(*) AS count FROM bookings WHERE tour_date >= $1 AND tour_date < $2 GROUP BY program ORDER BY count DESC LIMIT 5`, [start, end]
    );
    console.log('[DEBUG] Top destinations:', destRows.length);

    // Percent changes (this month vs last month)
    let percentNew = null, percentEarnings = null, percentTotal = null;
    if (period === 'thisMonth') {
      const [lastStart, lastEnd] = getBangkokDateRange('lastMonth');
      const { rows: lastNewRows } = await sql.query(
        `SELECT COUNT(*) AS count FROM bookings WHERE created_at >= $1 AND created_at < $2`, [lastStart, lastEnd]
      );
      const lastNew = parseInt(lastNewRows[0].count, 10);
      percentNew = lastNew === 0 ? null : ((newBookings - lastNew) / lastNew) * 100;
      const { rows: lastPaidRows } = await sql.query(
        `SELECT COALESCE(SUM(paid),0) AS sum FROM bookings WHERE tour_date >= $1 AND tour_date < $2`, [lastStart, lastEnd]
      );
      const lastEarnings = parseFloat(lastPaidRows[0].sum);
      percentEarnings = lastEarnings === 0 ? null : ((totalEarnings - lastEarnings) / lastEarnings) * 100;
      // Add percentTotal: compare totalBookings (this month) to last month's totalBookings
      const { rows: lastTotalRows } = await sql.query(
        `SELECT COUNT(*) AS count FROM bookings WHERE tour_date >= $1 AND tour_date < $2`, [lastStart, lastEnd]
      );
      const lastTotal = parseInt(lastTotalRows[0].count, 10);
      percentTotal = lastTotal === 0 ? null : ((totalBookings - lastTotal) / lastTotal) * 100;
    }

    // Total adults and children (for Passengers card)
    const { rows: paxRows } = await sql.query(
      `SELECT COALESCE(SUM(adult),0) AS adults, COALESCE(SUM(child),0) AS children FROM bookings WHERE tour_date >= $1 AND tour_date < $2`, [start, end]
    );
    const totalAdults = parseInt(paxRows[0].adults, 10);
    const totalChildren = parseInt(paxRows[0].children, 10);

    // Booking counts by channel (Website, GYG, Viator)
    const { rows: allRows } = await sql.query(
      `SELECT booking_number FROM bookings WHERE tour_date >= $1 AND tour_date < $2`, [start, end]
    );
    let websiteCount = 0, gygCount = 0, viatorCount = 0;
    allRows.forEach(row => {
      if (row.booking_number.startsWith('6')) websiteCount++;
      else if (row.booking_number.startsWith('GYG')) gygCount++;
      else viatorCount++;
    });
    const channels = [
      { channel: 'Website', count: websiteCount },
      { channel: 'GYG', count: gygCount },
      { channel: 'Viator', count: viatorCount }
    ];

    res.status(200).json({
      totalBookings,
      newBookings,
      totalEarnings,
      done,
      booked,
      revenueByDay: revenueRows,
      topDestinations: destRows,
      percentNew,
      percentEarnings,
      percentTotal,
      period,
      start,
      end,
      totalAdults,
      totalChildren,
      channels
    });
  } catch (err) {
    console.error('Dashboard API error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard analytics', details: err.message });
  }
}; 