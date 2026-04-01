/**
 * Multi-step Q&A definitions for each Manager section.
 * 
 * loop: true  → Questions repeat in cycles until user stops (e.g. Lead, Bosh xonalar)
 * loop: false → Questions asked once in sequence (default)
 * options: [] → Displays an inline keyboard with choices instead of waiting for text input
 */

const SECTIONS = {
    'lead': {
        title: '📈 Lead qo\'shish',
        buttonText: '📈 Lead qo\'shish',
        loop: true, // Repeating cycle
        itemLabel: 'fan',
        questions: [
            { key: 'subject', question: "Qaysi fan?", dynamicOptions: 'subjects' },
            { key: 'count', question: "Nechta lead qo'shildi?" }
        ]
    },
    'lead_remove': {
        title: '📉 Lead o\'chirish',
        buttonText: '📉 Lead o\'chirish',
        loop: true,
        itemLabel: 'fan',
        questions: [
            { key: 'subject', question: "Qaysi fandan lead ayriladi / o'chiriladi?", dynamicOptions: 'subjects' },
            { key: 'count', question: "Nechta lead ayriladi?" }
        ]
    },
    'qarzdorlar': {
        title: '💸 Qarzdorlar bo\'limi',
        buttonText: '💸 Qarzdorlar bo\'limi',
        questions: [
            { key: 'month', question: "Qaysi oy uchun?", dynamicOptions: 'last_6_months' },
            { key: 'count', question: "Nechta yangi qarzdor qo'shildi?" },
            { key: 'amount', question: "Ularning umumiy qarz miqdori qancha?" }
        ]
    },
    'qarzdorlar_remove': {
        title: '📉 Qarzdorlikni o\'chirish',
        buttonText: '📉 Qarzdorlikni o\'chirish',
        questions: [
            { key: 'month', question: "Qaysi oy uchun?", dynamicOptions: 'last_6_months' },
            { key: 'count', question: "Nechta qarzdorning qarzi uzildi (ayrilishi kerak)?" },
            { key: 'amount', question: "Qancha qarz uzildi?" }
        ]
    },
    'bosh_xonalar': {
        title: '🏫 Bosh xonalar bo\'limi',
        buttonText: '🏫 Bosh xonalar',
        loop: true, // Repeating cycle
        itemLabel: 'xona',
        questions: [
            { key: 'branch', question: "Qaysi filialda?" },
            { key: 'room', question: "Qaysi xona bo'sh?" },
            { key: 'days', question: "Qaysi kunlari?", options: ['Toq kunlar', 'Juft kunlar'] },
            { key: 'period', question: "Xona qay vaqtda bo'sh?", options: ['Tushlikgacha', 'Tushlikdan keyin', 'To\'liq kun'] },
            { key: 'time', question: "Soat nechida? (Masalan: 14:00-16:00)" },
            { key: 'capacity', question: "Xona nechta o'quvchi sig'adi?" },
            { key: 'price_per_student', question: "Kurs narxi qancha? (so'm)" }
        ]
    },
    'rad_etilganlar': {
        title: '❌ Rad etilganlar qo\'shish',
        buttonText: '❌ Rad etilganlar',
        loop: true,
        itemLabel: 'fan',
        questions: [
            { key: 'subject', question: "Qaysi fan?", dynamicOptions: 'subjects' },
            { key: 'count', question: "Nechta o'quvchi rad etdi?" }
        ]
    },
    'rad_remove': {
        title: '📉 Rad etilganlar o\'chirish',
        buttonText: '📉 Rad etilganlar o\'chirish',
        loop: true,
        itemLabel: 'fan',
        questions: [
            { key: 'subject', question: "Qaysi fandan rad etilgan o'quvchilar ayriladi / o'chiriladi?", dynamicOptions: 'subjects' },
            { key: 'count', question: "Nechta o'quvchi ayriladi?" }
        ]
    },
'moliya_kirim_rasmiy': {
        title: '🏢 Rasmiy Kirim (Tushum)',
        buttonText: '🏢 Rasmiy tushum',
        questions: [
            { key: 'month', question: "Qaysi oy uchun?", dynamicOptions: 'last_6_months' },
            { key: 'today_income', question: "Tushum miqdorini kiriting" },
            { key: 'today_kassa_students', question: "Nechta o'quvchi uchun?" },
            { key: 'comment', question: "Izoh qoldiring (ixtiyoriy):", options: ['O\'tkazib yuborish'] }
        ]
    },
    'moliya_kirim_norasmiy': {
        title: '🏠 Norasmiy Kirim (Tushum)',
        buttonText: '🏠 Norasmiy tushum',
        questions: [
            { key: 'month', question: "Qaysi oy uchun?", dynamicOptions: 'last_6_months' },
            { key: 'today_income', question: "Tushum miqdorini kiriting" },
            { key: 'today_kassa_students', question: "Nechta o'quvchi uchun?" },
            { key: 'comment', question: "Izoh qoldiring (ixtiyoriy):", options: ['O\'tkazib yuborish'] }
        ]
    },
'moliya_kirim_rasmiy_del': {
        title: '🏢 Rasmiy kirimni bekor qilish',
        buttonText: '🏢 Rasmiy kirim (Bekor)',
        questions: [
            { key: 'month', question: "Qaysi oy uchun?", dynamicOptions: 'last_6_months' },
            { key: 'today_income', question: "Qancha tushum xato o'tdi? (minuslarsiz kiring)" },
            { key: 'today_kassa_students', question: "Nechta o'quvchi uchun xato o'tdi?" },
            { key: 'comment', question: "Izoh qoldiring (ixtiyoriy):", options: ['O\'tkazib yuborish'] }
        ]
    },
    'moliya_kirim_norasmiy_del': {
        title: '🏠 Norasmiy kirimni bekor qilish',
        buttonText: '🏠 Norasmiy kirim (Bekor)',
        questions: [
            { key: 'month', question: "Qaysi oy uchun?", dynamicOptions: 'last_6_months' },
            { key: 'today_income', question: "Qancha tushum xato o'tdi? (minuslarsiz kiring)" },
            { key: 'today_kassa_students', question: "Nechta o'quvchi uchun xato o'tdi?" },
            { key: 'comment', question: "Izoh qoldiring (ixtiyoriy):", options: ['O\'tkazib yuborish'] }
        ]
    },
'moliya_chiqim_rasmiy': {
        title: '🏢 Rasmiy Chiqim (Xarajat)',
        buttonText: '🏢 Rasmiy xarajat',
        questions: [
            { key: 'month', question: "Qaysi oy uchun?", dynamicOptions: 'last_6_months' },
            { key: 'today_expense', question: "Xarajat qancha?" },
            { key: 'expense_type', question: "Qaysi turdagi xarajat?", dynamicOptions: 'expense_types' },
            { key: 'comment', question: "Xarajat haqida qisqacha izoh yozing:", options: ['O\'tkazib yuborish'] }
        ]
    },
    'moliya_chiqim_norasmiy': {
        title: '🏠 Norasmiy Chiqim (Xarajat)',
        buttonText: '🏠 Norasmiy xarajat',
        questions: [
            { key: 'month', question: "Qaysi oy uchun?", dynamicOptions: 'last_6_months' },
            { key: 'today_expense', question: "Xarajat qancha?" },
            { key: 'expense_type', question: "Qaysi turdagi xarajat?", dynamicOptions: 'expense_types' },
            { key: 'comment', question: "Xarajat haqida qisqacha izoh yozing:", options: ['O\'tkazib yuborish'] }
        ]
    },
    'moliya_chiqim_del': {
        title: '📉 Chiqimni bekor qilish',
        buttonText: '📉 Chiqim (O\'chirish)',
        questions: [
            { key: 'month', question: "Qaysi oy uchun?", dynamicOptions: 'last_6_months' },
            { key: 'today_expense', question: "Qancha xarajat xato kiritildi? (Summani kiriting)" },
            { key: 'expense_type', question: "U qaysi turdagi xarajat edi?", dynamicOptions: 'expense_types' },
            { key: 'comment', question: "Izoh qoldiring (ixtiyoriy):", options: ['O\'tkazib yuborish'] }
        ]
    },
    'davomat': {
        title: '📋 Davomat',
        buttonText: '📋 Davomat',
        questions: [
            { key: 'expected', question: "Bugun umumiy o'quv markazga nechta o'quvchi kelishi kerak?" },
            { key: 'attended', question: "Nechtasi keldi?" }
        ]
    }
};

module.exports = { SECTIONS };
