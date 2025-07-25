const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');
const axios = require('axios');
const { sql } = require('@vercel/postgres');
const { convert } = require('html-to-text');
const configData = require('../config.json');
const NotificationManager = require('../notificationManager');

async function handleTelegramCallback(callbackQuery, res) {
    const { data, message } = callbackQuery;
    console.log('TELEGRAM CALLBACK DATA:', data);
    if (!data || !message) {
        console.error('Invalid callback query format');
        return res.status(400).send('Invalid callback query format');
    }

    const parts = data.split(':');
    const action = parts[0];
    const buttonType = parts[1];
    const bookingId = parts.slice(2).join(':');

    // Accept op, ri, customer, parkfee
    if (action !== 'toggle' || !['op', 'ri', 'customer', 'parkfee'].includes(buttonType)) {
        console.error('Invalid callback data:', data);
        return res.status(400).send('Invalid callback data');
    }

    try {
        // Fetch the latest booking state
        const { rows } = await sql.query('SELECT * FROM bookings WHERE booking_number = $1', [bookingId]);
        if (!rows.length) {
            console.error('Booking not found for callback:', bookingId);
            return res.status(404).send('Booking not found');
        }
        const booking = rows[0];
        console.log('Booking before update:', booking);
        let update = {};
        if (buttonType === 'op') {
            update.op = !booking.op;
            // If OP is turned off, also turn off Customer
            if (!update.op) update.customer = false;
            console.log(`Toggling OP to ${update.op}, Customer to ${update.customer}`);
        } else if (buttonType === 'ri') {
            update.ri = !booking.ri;
            console.log(`Toggling RI to ${update.ri}`);
        } else if (buttonType === 'customer') {
                // Only allow setting customer to true if op is true
            if (!booking.op) {
                    // Send error to Telegram with a short message and log the response
                    const popupText = 'OP must be ✓ first.';
                    try {
                    const token = await getTelegramBotToken();
                    await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                            callback_query_id: callbackQuery.id,
                            text: popupText,
                            show_alert: true
                        });
                    } catch (popupErr) {
                        console.error('Error sending Telegram popup alert:', popupErr.response ? popupErr.response.data : popupErr.message);
                    }
                console.warn('Tried to toggle Customer but OP is not enabled.');
                    return res.status(200).send('OP not send yet');
                }
            update.customer = !booking.customer;
            console.log(`Toggling Customer to ${update.customer}`);
        } else if (buttonType === 'parkfee') {
            update.national_park_fee = !booking.national_park_fee;
            console.log(`Toggling National Park Fee to ${update.national_park_fee}`);
        }
        // Build the update query
        const setClauses = Object.keys(update).map((col, i) => `${col} = $${i + 2}`);
        const values = [bookingId, ...Object.values(update)];
        if (setClauses.length > 0) {
            console.log('Updating booking with:', update);
            await sql.query(`UPDATE bookings SET ${setClauses.join(', ')} WHERE booking_number = $1`, values);
        }
        // Fetch the updated booking
        const { rows: updatedRows } = await sql.query('SELECT * FROM bookings WHERE booking_number = $1', [bookingId]);
        const updatedBooking = updatedRows[0];
        console.log('Booking after update:', updatedBooking);
        // Rebuild the message and keyboard
        const nm = new NotificationManager();
        const newMessage = nm.constructNotificationMessage(updatedBooking);
        const opText = `OP${updatedBooking.op ? ' ✓' : ' X'}`;
        const riText = `RI${updatedBooking.ri ? ' ✓' : ' X'}`;
        const customerText = `Customer${updatedBooking.customer ? ' ✓' : ' X'}`;
        const parkFeeText = `Cash on tour : National Park Fee ${updatedBooking.national_park_fee ? '✅' : '❌'}`;
        const monoMessage = '```' + newMessage + '```';
        const newKeyboard = {
            inline_keyboard: [
                [
                    { text: opText, callback_data: `toggle:op:${bookingId}` },
                    { text: riText, callback_data: `toggle:ri:${bookingId}` },
                    { text: customerText, callback_data: `toggle:customer:${bookingId}` }
                ],
                [
                    { text: parkFeeText, callback_data: `toggle:parkfee:${bookingId}` }
                ]
            ]
        };
        // Edit the message (monospace)
        try {
            const token = await getTelegramBotToken();
            const editResp = await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
            chat_id: message.chat.id,
            message_id: message.message_id,
                text: monoMessage,
                parse_mode: 'Markdown',
                reply_markup: newKeyboard
        });
            console.log('editMessageText response:', editResp.data);
        } catch (editErr) {
            console.error('Error editing Telegram message:', editErr.response ? editErr.response.data : editErr.message);
        }
        const token = await getTelegramBotToken();
        await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            callback_query_id: callbackQuery.id
        });
        return res.status(200).send('OK');
    } catch (error) {
        console.error('Callback handler error:', error);
        return res.status(200).send('Error processing callback');
    }
}

// Utility function to clean HTML and extract text content
function cleanupHtml(html) {
    if (!html) return '';
    return convert(html, {
        wordwrap: false,
        selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' },
        ]
    });
}

// All classes and managers removed for this test.
// Hardcoding the BokunParser logic directly in the handler.

// Helper to read the raw request body from the stream
async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

class BaseEmailParser {
  constructor(content) {
    this.content = content;
  }
  extractAll() { throw new Error("Not implemented"); }
  formatBookingDetails() { throw new Error("Not implemented"); }
  _formatBaseBookingDetails(extractedInfo) {
    const adult = parseInt(extractedInfo.adult, 10) || 0;
    const child = parseInt(extractedInfo.child, 10) || 0;
    const infant = parseInt(extractedInfo.infant, 10) || 0;
    const parts = [];
    if (adult > 0) parts.push(`${adult} ${adult > 1 ? 'Adults' : 'Adult'}`);
    if (child > 0) parts.push(`${child} ${child > 1 ? 'Children' : 'Child'}`);
    if (infant > 0) parts.push(`${infant} ${infant > 1 ? 'Infants' : 'Infant'}`);
    let paxString = parts.join(' , ');
    if (!paxString) paxString = "0 Adults";
    const responseTemplate = `Please confirm the *pickup time* for this booking:\n\nBooking no : ${extractedInfo.bookingNumber}\nTour date : ${extractedInfo.tourDate}\nProgram : ${extractedInfo.program}\nName : ${extractedInfo.name}\nPax : ${paxString}\nHotel : ${extractedInfo.hotel}\nPhone Number : ${extractedInfo.phoneNumber}\nCash on tour : None\n\nPlease mentioned if there is any additional charge for transfer collect from customer`;
    return { responseTemplate, extractedInfo };
  }

  // New method to convert parsed date to YYYY-MM-DD format for DB
  _getISODate(dateString) {
      if (!dateString || dateString === 'N/A') return null;

      // Handle "dd.Mmm 'yy" format (e.g., 21.Jun '25)
      const dotMatch = dateString.match(/(\d{1,2})\.([A-Za-z]{3})\s'(\d{2})/);
      if (dotMatch) {
          const day = dotMatch[1];
          const month = dotMatch[2];
          const year = `20${dotMatch[3]}`;
          // new Date() can parse "21 Jun 2025"
          return new Date(`${day} ${month} ${year}`).toISOString().split('T')[0];
      }

      // Handle "Month Day, Year" format (e.g., May 6, 2026)
      const commaMatch = new Date(dateString);
      if (!isNaN(commaMatch.getTime())) {
          return commaMatch.toISOString().split('T')[0];
      }
      
      return null;
  }
}

class BokunParser extends BaseEmailParser {
  constructor(htmlContent) {
    super(htmlContent);
    try {
        const cleanedHtml = htmlContent.replace(/=\s*\r?\n/g, '').replace(/=3D/g, '=');
        this.$ = cheerio.load(cleanedHtml);
        this.textContent = cleanupHtml(htmlContent); // For text search
    } catch (error) {
        throw new Error('BokunParser failed to load HTML.');
    }
  }
  findValueByLabel(label) {
    let value = '';
    this.$('td').each((i, el) => {
      const strongText = this.$(el).find('strong').text().trim();
      if (strongText.toLowerCase() === label.toLowerCase()) {
        value = this.$(el).next('td').text().trim();
        if (value) return false;
      }
    });
    return value.replace(/\s{2,}/g, ' ').trim();
  }
  extractBookingNumber() { return this.findValueByLabel('Ext. booking ref'); }
  extractTourDate() {
    const dateText = this.findValueByLabel('Date');
    // More robust regex: handles optional day of week, and space or period after the day number.
    const dateMatch = dateText.match(/(\d{1,2})[\.\s]([A-Za-z]{3}\s'\d{2})/);
    if (dateMatch && dateMatch[1] && dateMatch[2]) {
        // Reconstruct to "DD.Mmm 'YY" format for consistency.
        return `${dateMatch[1]}.${dateMatch[2]}`;
    }
    return 'N/A';
  }
  extractProgram() {
    return this.findValueByLabel('Product').replace(/^[A-Z0-9]+\s*-\s*/, '').replace(/[^a-zA-Z0-9\s,:'&\-]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  extractName() { return this.findValueByLabel('Customer'); }
  extractPassengers() {
    const pax = { adult: '0', child: '0', infant: '0' };
    const paxCell = this.$('strong').filter((i, el) => this.$(el).text().trim().toLowerCase() === 'pax').first().closest('td').next('td');
    let lines = [];
    const paxHtml = paxCell.html();
    if (paxHtml) {
      lines = paxHtml.split(/<br\s*\/?>/i).map(l => this.$(`<div>${l}</div>`).text()).join('\n').split(/\n|\r/).map(l => l.trim()).filter(Boolean);
    } else {
      lines = paxCell.text().split(/\n|\r/).map(l => l.trim()).filter(Boolean);
    }
    if (lines.length === 0) {
      lines = [paxCell.text().trim()];
    }
    lines.forEach(line => {
      let m;
      m = line.match(/(\d+)\s*Adult/i);
      if (m) pax.adult = (parseInt(pax.adult, 10) + parseInt(m[1], 10)).toString();
      m = line.match(/(\d+)\s*Child/i);
      if (m) pax.child = (parseInt(pax.child, 10) + parseInt(m[1], 10)).toString();
      m = line.match(/(\d+)\s*Infant/i);
      if (m) pax.infant = (parseInt(pax.infant, 10) + parseInt(m[1], 10)).toString();
      m = line.match(/(\d+)\s*Rider/i);
      if (m) pax.adult = (parseInt(pax.adult, 10) + parseInt(m[1], 10)).toString();
      m = line.match(/(\d+)\s*Passenger/i);
      if (m) pax.child = (parseInt(pax.child, 10) + parseInt(m[1], 10)).toString();
    });
    return pax;
  }
  extractHotel() { return this.findValueByLabel('Pick-up').replace(/[^a-zA-Z0-9\s,:'&\-]/g, ' ').replace(/\s+/g, ' ').trim(); }
  extractPhone() { return this.findValueByLabel('Customer phone').replace(/\D/g, ''); }
  extractSKU() {
    // Product field: e.g., 'HKT0041 - ...'
    const product = this.findValueByLabel('Product');
    const match = product.match(/^([A-Z0-9]+)\s*-/);
    return match ? match[1] : '';
  }
  extractPaid() {
    // Look for 'Viator amount: THB 1234.56' in the text content
    const match = this.textContent.match(/Viator amount:\s*THB\s*([\d,.]+)/i);
    if (match && match[1]) {
      // Remove commas, parse as float, fix to 2 decimals
      return parseFloat(match[1].replace(/,/g, '')).toFixed(2);
    }
    return null;
  }
  extractBookDate() {
    // Look for a line like 'Created\tFri, July 04 2025 @ 23:17'
    const match = this.textContent.match(/Created\s*[\t:]*\s*([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2}\s+\d{4})/);
    if (match && match[1]) {
      // Remove day of week if present (e.g., 'Fri, July 04 2025' -> 'July 04 2025')
      const dateStr = match[1].replace(/^[A-Za-z]+,?\s+/, '');
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
    return null;
  }
  extractRate() {
    // Try to find a line or cell labeled 'Rate' and extract its value
    let rate = '';
    this.$('td').each((i, el) => {
      const strongText = this.$(el).find('strong').text().trim();
      if (strongText.toLowerCase() === 'rate') {
        rate = this.$(el).next('td').text().trim();
        if (rate) return false;
      }
    });
    return rate;
  }
  extractAll() {
    const passengers = this.extractPassengers();
    const tourDate = this.extractTourDate();
    return {
      bookingNumber: this.extractBookingNumber(),
      tourDate: tourDate,
      sku: this.extractSKU(),
      program: this.extractProgram(),
      name: this.extractName(),
      adult: passengers.adult, child: passengers.child, infant: passengers.infant,
      hotel: this.extractHotel(), phoneNumber: this.extractPhone(),
      isoDate: this._getISODate(tourDate),
      paid: this.extractPaid(),
      book_date: this.extractBookDate(),
      rate: this.extractRate()
    };
  }
  formatBookingDetails() {
    return this._formatBaseBookingDetails(this.extractAll());
  }
}

class ThailandToursParser extends BaseEmailParser {
    constructor(textContent) {
        super(textContent);
        this.lines = textContent.split('\n').map(line => line.trim());
    }

    _findLineValue(label) {
        const line = this.lines.find(l => l.toLowerCase().startsWith(label.toLowerCase()));
        return line ? line.substring(label.length).trim() : 'N/A';
    }
    
    extractBookingNumber() {
        return this._findLineValue('ORDER NUMBER:');
    }

    extractProgram() {
        // The program name is the line right before the line with the product code, e.g., "(#HKT0022)"
        const codeIndex = this.lines.findIndex(line => /\(#([A-Z0-9]+)\)/.test(line));
        if (codeIndex > 0) {
            // Check the line immediately before the code; it might be blank.
            const lineBefore = this.lines[codeIndex - 1].trim();
            if (lineBefore) {
                return lineBefore;
            }
            // If the line before was blank, check the one before that.
            if (codeIndex > 1 && this.lines[codeIndex - 2]) {
                return this.lines[codeIndex - 2].trim();
            }
        }
        return 'N/A';
    }

    extractTourDate() {
        // The tour date is on a line like "* June 22, 2025"
        const dateLine = this.lines.find(line => line.trim().startsWith('*') && /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(line));
        if (dateLine) {
            const dateMatch = dateLine.match(/[A-Za-z]+ \d{1,2}, \d{4}/);
            if (dateMatch) return dateMatch[0];
        }
        return 'N/A';
    }

    extractPassengers() {
        const pax = { adult: '0', child: '0', infant: '0' };
        for (const line of this.lines) {
            // Adult
            const adultMatch = line.match(/adult[s]?[^\d]*(\d+)\s*$/i) || line.match(/adult[s]?.*?:\s*(\d+)/i);
            if (adultMatch && adultMatch[1]) {
                pax.adult = (parseInt(pax.adult, 10) + parseInt(adultMatch[1], 10)).toString();
            }
            // Child
            const childMatch = line.match(/child[ren|s]?[^\d]*(\d+)\s*$/i) || line.match(/child[ren|s]?.*?:\s*(\d+)/i);
            if (childMatch && childMatch[1]) {
                pax.child = (parseInt(pax.child, 10) + parseInt(childMatch[1], 10)).toString();
            }
            // Infant
            const infantMatch = line.match(/infant[s]?[^\d]*(\d+)\s*$/i) || line.match(/infant[s]?.*?:\s*(\d+)/i);
            if (infantMatch && infantMatch[1]) {
                pax.infant = (parseInt(pax.infant, 10) + parseInt(infantMatch[1], 10)).toString();
            }
            // Person (+4 Years): N (treat as adult)
            const personPlusMatch = line.match(/person \(\+\d+ years\):\s*(\d+)/i);
            if (personPlusMatch && personPlusMatch[1]) {
                pax.adult = (parseInt(pax.adult, 10) + parseInt(personPlusMatch[1], 10)).toString();
            }
        }
        // If no explicit adult/child/infant found, fallback to 'Person: N'
        if (pax.adult === '0' && pax.child === '0' && pax.infant === '0') {
            const personLine = this.lines.find(line => /person\s*:\s*\d+/i.test(line));
            if (personLine) {
                const personMatch = personLine.match(/person\s*:\s*(\d+)/i);
                if (personMatch && personMatch[1]) {
                    pax.adult = (parseInt(pax.adult, 10) + parseInt(personMatch[1], 10)).toString();
                    pax.child = '0';
                    pax.infant = '0';
                }
            }
        }
        return pax;
    }

    extractName() {
        // The customer name is two lines after "BILLING ADDRESS" because of a blank line
        const billingIndex = this.lines.findIndex(line => line.toLowerCase() === 'billing address');
        if (billingIndex !== -1 && this.lines.length > billingIndex + 2) {
            return this.lines[billingIndex + 2].trim();
        }
        return 'N/A';
    }
    
    extractHotel() {
        // The hotel name is three lines after "BILLING ADDRESS"
        const billingIndex = this.lines.findIndex(line => line.toLowerCase() === 'billing address');
        if (billingIndex !== -1 && this.lines.length > billingIndex + 3) {
            const line3 = this.lines[billingIndex + 3].trim();
            const line4 = this.lines.length > billingIndex + 4 ? this.lines[billingIndex + 4].trim() : null;
            
            let hotel = line3;
            if (line4 && !line4.startsWith('+') && !line4.includes('@')) {
                hotel += `, ${line4}`;
            }
            return hotel;
        }
        return 'N/A';
    }

    extractPhone() {
        // The phone number is on a line that starts with a plus, and is inside the address block
        const billingIndex = this.lines.findIndex(line => line.toLowerCase() === 'billing address');
        if (billingIndex !== -1) {
            const addressBlock = this.lines.slice(billingIndex);
            const phoneLine = addressBlock.find(line => line.startsWith('+'));
            return phoneLine ? phoneLine.replace(/\D/g, '') : 'N/A';
        }
        return 'N/A';
    }

    extractSKU() {
        // Find a line with (#CODE) and extract CODE
        const line = this.lines.find(l => /\(#([A-Z0-9]+)\)/.test(l));
        if (line) {
          const match = line.match(/\(#([A-Z0-9]+)\)/);
          return match ? match[1] : '';
        }
        // Fallback: first #CODE in the email
        const hashLine = this.lines.find(l => /#([A-Z0-9]+)/.test(l));
        if (hashLine) {
          const match = hashLine.match(/#([A-Z0-9]+)/);
          return match ? match[1] : '';
        }
        return '';
    }

    extractPaid() {
      // Look for 'Total:' followed by optional whitespace, optional Baht symbol, and a number (with or without commas)
      const totalLine = this.lines.find(line => /Total:/i.test(line));
      if (totalLine) {
        // Match Total: [optional Baht symbol or encoding] [number]
        const match = totalLine.match(/Total:\s*[฿=E0=B8=BF]?\s*([\d,\.]+)/i);
        if (match && match[1]) {
          return parseFloat(match[1].replace(/,/g, '')).toFixed(2);
        }
      }
      // Fallback: try to find in the whole text (for HTML emails or encoded lines)
      const text = this.lines.join(' ');
      const match = text.match(/Total:\s*[฿=E0=B8=BF]?\s*([\d,\.]+)/i);
      if (match && match[1]) {
        return parseFloat(match[1].replace(/,/g, '')).toFixed(2);
      }
      return null;
    }

    extractBookDate() {
      // Look for a line like 'Order date: July 5, 2025'
      const line = this.lines.find(l => l.toLowerCase().startsWith('order date:'));
      if (line) {
        const match = line.match(/Order date:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
        if (match && match[1]) {
          const d = new Date(match[1]);
          if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
        }
      }
      return null;
    }

    extractRate() {
        // Look for a line starting with 'Program:' and extract the next non-empty line as the rate title
        const programIdx = this.lines.findIndex(line => line.toLowerCase().startsWith('program:'));
        if (programIdx !== -1) {
            // The rate title is usually on the same line or the next line
            const after = this.lines[programIdx].replace(/^program:/i, '').trim();
            if (after) return after;
            // Or next line
            if (this.lines[programIdx + 1]) return this.lines[programIdx + 1].trim();
        }
        // Fallback: look for a line like 'Program Rock 1'
        const rateLine = this.lines.find(line => /program\s+rock/i.test(line));
        if (rateLine) return rateLine.trim();
        return '';
    }

    extractStartTime() {
        // Look for a line starting with 'Start time:'
        const timeLine = this.lines.find(line => line.toLowerCase().startsWith('start time:'));
        if (timeLine) {
            return timeLine.replace(/^start time:/i, '').trim();
        }
        return '';
    }

    extractAll() {
        const passengers = this.extractPassengers();
        const tourDate = this.extractTourDate();
        return {
            bookingNumber: this.extractBookingNumber(),
            tourDate: tourDate,
            sku: this.extractSKU(),
            program: this.extractProgram(),
            name: this.extractName(),
            adult: passengers.adult,
            child: passengers.child,
            infant: passengers.infant,
            hotel: this.extractHotel(),
            phoneNumber: this.extractPhone(),
            isoDate: this._getISODate(tourDate),
            paid: this.extractPaid(),
            book_date: this.extractBookDate(),
            rate: this.extractRate(),
            start_time: this.extractStartTime()
        };
    }

    formatBookingDetails() {
        const extractedInfo = this.extractAll();

        if (extractedInfo.tourDate === 'N/A' || !extractedInfo.isoDate) {
            console.error(`Could not extract a valid tour date for booking ${extractedInfo.bookingNumber}. Aborting.`);
        }
        
        return this._formatBaseBookingDetails(extractedInfo);
    }
}

class EmailParserFactory {
  static create(parsedEmail) {
    const { subject, html, text, from } = parsedEmail;
    const fromAddress = from?.value?.[0]?.address?.toLowerCase();
    let channel = null;
    if (fromAddress && fromAddress.includes('bokun.io')) {
      channel = 'bokun';
    } else if (fromAddress && fromAddress.includes('tours.co.th')) {
      channel = 'tours.co.th';
    } else if (fromAddress && fromAddress.includes('getyourguide')) {
      channel = 'getyourguide';
    } else {
      channel = 'other';
    }

    if (!subject || (!subject.toLowerCase().startsWith('new booking') && !subject.toLowerCase().startsWith('updated booking'))) {
      return null;
    }

    const content = html || text;
    
    if (fromAddress && fromAddress.includes('bokun.io')) {
      return new BokunParser(content);
    }
    
    if (fromAddress && fromAddress.includes('tours.co.th')) {
        const textContent = cleanupHtml(content);
        return new ThailandToursParser(textContent);
    }
    
    const textContent = cleanupHtml(content);
    return new FallbackParser(textContent);
  }
}

class FallbackParser extends BaseEmailParser {
    constructor(textContent) {
        super(textContent);
        this.lines = textContent.split('\n').map(line => line.trim());
    }

    _findLineValue(label) {
        const line = this.lines.find(l => l.toLowerCase().startsWith(label.toLowerCase()));
        return line ? line.substring(label.length).trim() : 'N/A';
    }
    
    extractBookingNumber() { return this._findLineValue('booking no :'); }
    extractTourDate() { return this._findLineValue('tour date :'); }
    extractProgram() { return this._findLineValue('program :'); }
    extractName() { return this._findLineValue('name :'); }
    extractPassengers() {
      const paxLine = this._findLineValue('pax :');
      const adults = paxLine.match(/(\d+)\s*Adult/i);
      const children = paxLine.match(/(\d+)\s*Child/i);
      const infants = paxLine.match(/(\d+)\s*Infant/i);
      const riders = paxLine.match(/(\d+)\s*Rider/i);
      const passengers = paxLine.match(/(\d+)\s*Passenger/i);
      let adultCount = adults ? parseInt(adults[1], 10) : 0;
      let childCount = children ? parseInt(children[1], 10) : 0;
      let infantCount = infants ? parseInt(infants[1], 10) : 0;
      if (riders && riders[1]) adultCount += parseInt(riders[1], 10);
      if (passengers && passengers[1]) childCount += parseInt(passengers[1], 10);
      return {
        adult: adultCount.toString(),
        child: childCount.toString(),
        infant: infantCount.toString()
      };
    }
    extractHotel() { return this._findLineValue('hotel :'); }
    extractPhone() { return this._findLineValue('phone number :'); }

    extractAll() {
        const passengers = this.extractPassengers();
        const tourDate = this.extractTourDate();
        return {
            bookingNumber: this.extractBookingNumber(),
            tourDate: tourDate,
            program: this.extractProgram(),
            name: this.extractName(),
            adult: passengers.adult,
            child: passengers.child,
            infant: passengers.infant,
            hotel: this.extractHotel(),
            phoneNumber: this.extractPhone(),
            isoDate: this._getISODate(tourDate)
        };
    }

    formatBookingDetails() {
        return this._formatBaseBookingDetails(this.extractAll());
    }
}

async function searchBookings(query) {
  // Try booking number (exact)
  let sqlQuery = 'SELECT * FROM bookings WHERE booking_number = $1';
  let params = [query];
  let { rows } = await sql.query(sqlQuery, params);
  if (rows.length > 0) return rows;
  // Try customer name (partial, case-insensitive)
  sqlQuery = 'SELECT * FROM bookings WHERE customer_name ILIKE $1 ORDER BY tour_date DESC LIMIT 3';
  params = [`%${query}%`];
  rows = (await sql.query(sqlQuery, params)).rows;
  if (rows.length > 0) return rows;
  // Try date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(query)) {
    sqlQuery = 'SELECT * FROM bookings WHERE tour_date::date = $1 ORDER BY tour_date DESC LIMIT 3';
    params = [query];
    rows = (await sql.query(sqlQuery, params)).rows;
    if (rows.length > 0) return rows;
  }
  // Try date in 'D MMM YY' or 'DD MMM YY' format (e.g., '17 May 25')
  const moment = require('moment');
  const parsed = moment(query, ['D MMM YY', 'DD MMM YY', 'D MMMM YY', 'DD MMMM YY'], true);
  if (parsed.isValid()) {
    const dateStr = parsed.format('YYYY-MM-DD');
    sqlQuery = 'SELECT * FROM bookings WHERE tour_date::date = $1 ORDER BY tour_date DESC LIMIT 3';
    params = [dateStr];
    rows = (await sql.query(sqlQuery, params)).rows;
    if (rows.length > 0) return rows;
  }
  return [];
}

function extractQuery(text, botUsername) {
  if (!text) return '';
  text = text.trim();
  // Handle /search command
  if (text.startsWith('/search')) {
    return text.replace(/^\/search(@\w+)?\s*/i, '');
  }
  // Handle mention (e.g., @botname query)
  if (text.startsWith('@')) {
    // Remove @botname and any whitespace
    return text.replace(/^@\w+\s*/i, '');
  }
  // Otherwise, return as is
  return text;
}

// Helper to get Telegram Bot Token from settings
async function getTelegramBotToken() {
  const { rows } = await sql`SELECT telegram_bot_token FROM settings ORDER BY updated_at DESC LIMIT 1;`;
  return rows[0]?.telegram_bot_token || '';
}

// Helper to get Telegram Chat ID from settings
async function getTelegramChatId() {
  const { rows } = await sql`SELECT telegram_chat_id FROM settings ORDER BY updated_at DESC LIMIT 1;`;
  return rows[0]?.telegram_chat_id || '';
}

async function handler(req, res) {
    console.log('WEBHOOK REQUEST RECEIVED:', req.method, new Date().toISOString());
    console.log('Request headers:', req.headers);
    
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        // Get the raw body for email parsing
        let rawBody = await getRawBody(req);
        let sourceEmail = null;
        
        // Log the raw body for debugging
        console.log('Raw body length:', rawBody ? rawBody.length : 'null/undefined');
        console.log('Content-Type:', req.headers['content-type']);
        
        // Handle JSON payloads (for Telegram webhooks, etc.)
        if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
            try {
                const jsonData = JSON.parse(rawBody.toString('utf-8'));
                
                // Handle Telegram callback queries (inline keyboard)
                if (jsonData && jsonData.callback_query) {
                    return handleTelegramCallback(jsonData.callback_query, res);
                }

                // Handle Telegram /search command and general search
                if (jsonData && jsonData.message && jsonData.message.chat && jsonData.message.text) {
                    const chat_id = jsonData.message.chat.id;
                    const reply_to_message_id = jsonData.message.message_id;
                    const botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
                    const text = jsonData.message.text.trim();
                    const query = extractQuery(text, botUsername);
                    if (text.startsWith('/search')) {
                        if (!query) {
                            // Send help message
                            const token = await getTelegramBotToken();
                            const chatId = await getTelegramChatId();
                            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                                chat_id: chatId,
                                text: 'Please send /search <booking number>, customer name, or date (YYYY-MM-DD) to search.',
                                reply_to_message_id,
                                parse_mode: 'Markdown'
                            });
                            return res.json({ ok: true });
                        }
                        const results = await searchBookings(query);
                        if (results.length === 0) {
                            const token = await getTelegramBotToken();
                            const chatId = await getTelegramChatId();
                            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                                chat_id: chatId,
                                text: 'No bookings found for your query.',
                                reply_to_message_id,
                                parse_mode: 'Markdown'
                            });
                            return res.json({ ok: true });
                        }
                        const nm = new NotificationManager();
                        for (const booking of results) {
                            await nm.sendTelegramWithButtons(booking, chat_id);
                        }
                        return res.json({ ok: true });
                    } else if (!text.startsWith('/')) {
                        // If not a command, treat as search
                        if (!query) {
                            const token = await getTelegramBotToken();
                            const chatId = await getTelegramChatId();
                            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                                chat_id: chatId,
                                text: 'Please send a booking number, customer name, or date to search.',
                                reply_to_message_id,
                                parse_mode: 'Markdown'
                            });
                            return res.json({ ok: true });
                        }
                        const results = await searchBookings(query);
                        if (results.length === 0) {
                            const token = await getTelegramBotToken();
                            const chatId = await getTelegramChatId();
                            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                                chat_id: chatId,
                                text: 'No bookings found for your query.',
                                reply_to_message_id,
                                parse_mode: 'Markdown'
                            });
                            return res.json({ ok: true });
                        }
                        const nm = new NotificationManager();
                        for (const booking of results) {
                            await nm.sendTelegramWithButtons(booking, chat_id);
                        }
                        return res.json({ ok: true });
                    }
                    // Ignore other commands (like /start, /help, etc.)
                    return res.json({ ok: true });
                }
                
                // Handle other JSON payloads (like email services that send JSON)
                if (jsonData.raw) {
                    rawBody = Buffer.from(jsonData.raw, 'utf-8');
                    sourceEmail = jsonData.source;
                }
            } catch (jsonError) {
                console.log('Failed to parse JSON, treating as raw email:', jsonError.message);
            }
        }
        
        // Check if we have raw body for email parsing
        if (!rawBody) {
            console.error('Webhook error: rawBody is null or undefined');
            console.log('Request headers:', req.headers);
            console.log('Request method:', req.method);
            return res.status(400).json({ 
                error: 'No email content received',
                message: 'Please ensure the request contains email content in the body.',
                headers: req.headers
            });
        }
        
        // Parse the raw email
        const parsedEmail = await simpleParser(rawBody);

        // Handle cancellation emails
        if (parsedEmail.subject && parsedEmail.subject.startsWith('Cancelled booking:')) {
            // Extract booking number from 'Ext. booking ref: ...' in the subject
            const match = parsedEmail.subject.match(/Ext\. booking ref: ([A-Z0-9]+)/);
            if (match && match[1]) {
                const bookingNumber = match[1];
                console.log(`[CANCEL] Removing booking: ${bookingNumber}`);
                await sql`DELETE FROM bookings WHERE booking_number = ${bookingNumber}`;
                return res.status(200).send(`Webhook processed: Booking ${bookingNumber} removed (cancelled).`);
            } else {
                console.warn('[CANCEL] Cancelled booking email, but booking number not found in subject:', parsedEmail.subject);
                return res.status(400).send('Webhook processed: Cancelled booking email, but booking number not found in subject.');
            }
        }

        const parser = EmailParserFactory.create(parsedEmail);

        if (!parser) {
            console.warn('[SKIP] No suitable parser found or subject incorrect:', {
                subject: parsedEmail.subject,
                from: parsedEmail.from?.value?.[0]?.address,
            });
            return res.status(200).send('Email skipped: No suitable parser found or subject incorrect.');
        }

        const { responseTemplate, extractedInfo } = parser.formatBookingDetails();
        console.log('[PARSE] Extracted info:', extractedInfo);

        // Always insert or update into parsed_emails for analytics
        await sql`
          INSERT INTO parsed_emails (sender, subject, body, source_email, booking_number, parsed_at)
          VALUES (
            ${parsedEmail.from?.value?.[0]?.address || ''},
            ${parsedEmail.subject || ''},
            ${rawBody},
            ${sourceEmail},
            ${extractedInfo.bookingNumber || null},
            NOW()
          )
          ON CONFLICT (booking_number) DO UPDATE
            SET sender = EXCLUDED.sender,
                subject = EXCLUDED.subject,
                body = EXCLUDED.body,
                source_email = EXCLUDED.source_email,
                parsed_at = EXCLUDED.parsed_at;
        `;

        if (!extractedInfo || extractedInfo.tourDate === 'N/A' || !extractedInfo.isoDate) {
            console.warn('[SKIP] Skipped due to invalid date:', {
                bookingNumber: extractedInfo?.bookingNumber,
                tourDate: extractedInfo?.tourDate,
                isoDate: extractedInfo?.isoDate,
            });
            return res.status(200).send('Webhook processed: Skipped due to invalid date.');
        }
        if (!extractedInfo.bookingNumber) {
            console.warn('[SKIP] Skipped due to missing booking number:', extractedInfo);
            return res.status(200).send('Webhook processed: Skipped due to missing booking number.');
        }

        try {
            const { rows: existingBookings } = await sql`
                SELECT * FROM bookings WHERE booking_number = ${extractedInfo.bookingNumber};
            `;

            const adult = parseInt(extractedInfo.adult, 10) || 0;
            const child = parseInt(extractedInfo.child, 10) || 0;
            const infant = parseInt(extractedInfo.infant, 10) || 0;
            const paid = extractedInfo.paid !== undefined && extractedInfo.paid !== null && extractedInfo.paid !== '' ? Number(parseFloat(extractedInfo.paid).toFixed(2)) : null;

            if (existingBookings.length > 0) {
                // Compare all relevant fields
                const existing = existingBookings[0];
                let changed = false;
                const fields = [
                  ['tour_date', extractedInfo.isoDate],
                  ['sku', extractedInfo.sku],
                  ['program', extractedInfo.program],
                  ['customer_name', extractedInfo.name],
                  ['adult', adult],
                  ['child', child],
                  ['infant', infant],
                  ['hotel', extractedInfo.hotel],
                  ['phone_number', extractedInfo.phoneNumber],
                  ['raw_tour_date', extractedInfo.tourDate],
                  ['paid', paid],
                  ['book_date', extractedInfo.book_date],
                  ['rate', extractedInfo.rate]
                ];
                let updatedFields = existing.updated_fields || {};
                let anyFieldChanged = false;
                for (const [key, value] of fields) {
                  if ((existing[key] ?? '').toString() !== (value ?? '').toString()) {
                    updatedFields[key] = true;
                    anyFieldChanged = true;
                  }
                }
                // Remove highlights if more than one day after tour_date
                let clearHighlight = false;
                if (existing.tour_date) {
                  const today = new Date();
                  today.setHours(0,0,0,0);
                  let tourDateStr = '';
                  if (typeof existing.tour_date === 'string') {
                    tourDateStr = existing.tour_date.substring(0, 10);
                  } else if (existing.tour_date instanceof Date) {
                    tourDateStr = existing.tour_date.toISOString().substring(0, 10);
                  }
                  if (tourDateStr) {
                    const tourDate = new Date(tourDateStr);
                    const dayAfterTour = new Date(tourDate);
                    dayAfterTour.setDate(tourDate.getDate() + 1);
                    if (today > dayAfterTour) {
                      updatedFields = {};
                      clearHighlight = true;
                    }
                  }
                }
                if (anyFieldChanged || clearHighlight) {
                  console.log(`[UPDATE] Updating booking: ${extractedInfo.bookingNumber}`);
                  await sql`
                    UPDATE bookings SET tour_date=${extractedInfo.isoDate}, sku=${extractedInfo.sku}, program=${extractedInfo.program}, customer_name=${extractedInfo.name}, adult=${adult}, child=${child}, infant=${infant}, hotel=${extractedInfo.hotel}, phone_number=${extractedInfo.phoneNumber}, raw_tour_date=${extractedInfo.tourDate}, paid=${paid}, book_date=${extractedInfo.book_date}, rate=${extractedInfo.rate}, updated_fields=${JSON.stringify(updatedFields)}
                    WHERE booking_number = ${extractedInfo.bookingNumber}
                  `;
                  return res.status(200).send('Webhook processed: Booking updated.');
                } else {
                  console.log(`[UNCHANGED] Booking unchanged (no update needed): ${extractedInfo.bookingNumber}`);
                  return res.status(200).send('Webhook processed: Booking unchanged (no update needed).');
                }
            }
            
            if (adult === 0) {
                console.log(`[REMOVE] Removing booking (adult=0): ${extractedInfo.bookingNumber}`);
                await sql`DELETE FROM bookings WHERE booking_number = ${extractedInfo.bookingNumber}`;
                return res.status(200).send('Webhook processed: Booking removed (adult=0).');
            }
            
            // Determine channel based on sender or booking number
            let channel = 'Website';
            if (parsedEmail.from && parsedEmail.from.value && parsedEmail.from.value[0]) {
              const sender = parsedEmail.from.value[0].address || '';
              if (sender.includes('bokun.io')) channel = 'Bokun';
              else if (sender.includes('tours.co.th')) channel = 'tours.co.th';
              else if (sender.includes('getyourguide.com')) channel = 'GYG';
            }
            if (extractedInfo.bookingNumber && extractedInfo.bookingNumber.startsWith('GYG')) {
              channel = 'GYG';
            } else if (extractedInfo.bookingNumber && extractedInfo.bookingNumber.startsWith('6')) {
              channel = 'Website';
            } else if (!['Bokun', 'tours.co.th', 'GYG', 'Website'].includes(channel)) {
              channel = 'OTA';
            }

            console.log(`[INSERT] Inserting new booking: ${extractedInfo.bookingNumber}`);
            await sql`
                INSERT INTO bookings (booking_number, tour_date, sku, program, customer_name, adult, child, infant, hotel, phone_number, notification_sent, raw_tour_date, paid, book_date, channel, rate)
                VALUES (${extractedInfo.bookingNumber}, ${extractedInfo.isoDate}, ${extractedInfo.sku}, ${extractedInfo.program}, ${extractedInfo.name}, ${adult}, ${child}, ${infant}, ${extractedInfo.hotel}, ${extractedInfo.phoneNumber}, FALSE, ${extractedInfo.tourDate}, ${paid}, ${extractedInfo.book_date}, ${channel}, ${extractedInfo.rate})
                ON CONFLICT (booking_number) DO UPDATE SET
                  tour_date = EXCLUDED.tour_date,
                  sku = EXCLUDED.sku,
                  program = EXCLUDED.program,
                  customer_name = EXCLUDED.customer_name,
                  adult = EXCLUDED.adult,
                  child = EXCLUDED.child,
                  infant = EXCLUDED.infant,
                  hotel = EXCLUDED.hotel,
                  phone_number = EXCLUDED.phone_number,
                  notification_sent = EXCLUDED.notification_sent,
                  raw_tour_date = EXCLUDED.raw_tour_date,
                  paid = EXCLUDED.paid,
                  book_date = EXCLUDED.book_date,
                  channel = EXCLUDED.channel,
                  rate = EXCLUDED.rate;
            `;
            // Send Telegram notification if booking is for today (Bangkok time)
            const bangkokNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
            const bookingTourDate = new Date(extractedInfo.isoDate);
            if (
              bangkokNow.getFullYear() === bookingTourDate.getFullYear() &&
              bangkokNow.getMonth() === bookingTourDate.getMonth() &&
              bangkokNow.getDate() === bookingTourDate.getDate()
            ) {
              const nm = new NotificationManager();
              await nm.sendTelegramWithButtons({
                booking_number: extractedInfo.bookingNumber,
                tour_date: extractedInfo.isoDate,
                sku: extractedInfo.sku,
                program: extractedInfo.program,
                customer_name: extractedInfo.name,
                adult,
                child,
                infant,
                hotel: extractedInfo.hotel,
                phone_number: extractedInfo.phoneNumber,
                raw_tour_date: extractedInfo.tourDate,
                paid,
                book_date: extractedInfo.book_date,
                channel
              });
            }
            return res.status(200).send('Webhook processed: Booking upserted.');

        } catch (error) {
            console.error(`[ERROR][DB] Database error while processing booking ${extractedInfo.bookingNumber}:`, error);
            return res.status(500).send({ error: 'Database processing failed.', details: error.message });
        }

    } catch (error) {
        console.error('Error in webhook processing:', error);
        return res.status(500).json({ error: 'Error processing email.', details: error.message });
    }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
module.exports.BokunParser = BokunParser;
module.exports.ThailandToursParser = ThailandToursParser; 