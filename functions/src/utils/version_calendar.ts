import * as admin from 'firebase-admin';

const defaultCalendarPeriods = [
    {number: 1, long: 'January', short: 'Jan', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
    {number: 2, long: 'February', short: 'Feb', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
    {number: 3, long: 'March', short: 'Mar', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
    {number: 4, long: 'April', short: 'Apr', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
    {number: 5, long: 'May', short: 'May', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
    {number: 6, long: 'June', short: 'Jun', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
    {number: 7, long: 'July', short: 'Jul', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
    {number: 8, long: 'August', short: 'Aug', year: 1970,as_date: new admin.firestore.Timestamp(0,0)},
    {number: 9, long: 'September', short: 'Sep', year: 1970,as_date: new admin.firestore.Timestamp(0,0)},
    {number: 10, long: 'October', short: 'Oct', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
    {number: 11, long: 'November', short: 'Nov', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
    {number: 12, long: 'December', short: 'Dec', year: 1970, as_date: new admin.firestore.Timestamp(0,0)},
]
// const defaultCalendarTotal = {
//     long: 'Full Year', short: 'FY'
// }

export const initVersionCalendar = (beginMonth: number, beginYear: number) => {
    let newMonthsOrder = [];

    if(beginMonth > 1) {
        for(let fIdx = beginMonth - 1; fIdx < 12; fIdx++) {
            newMonthsOrder.push(defaultCalendarPeriods[fIdx]);
        }
        for(let sIdx = 0; sIdx < beginMonth - 1; sIdx++) {
            newMonthsOrder.push(defaultCalendarPeriods[sIdx]);
        }

    } else {
        newMonthsOrder = defaultCalendarPeriods;
    }

    let currentYear = beginYear;
    let midYearStart = false;

    if(newMonthsOrder[0].number > 1) {
        midYearStart = true;
    }

    for(const headerDefinition of newMonthsOrder) {
        if(midYearStart && headerDefinition.number == 1) {
            currentYear++;
        }
        headerDefinition.year = currentYear;
        const headerDate = new Date();
        headerDate.setUTCFullYear(currentYear);
        headerDate.setUTCMonth(headerDefinition.number - 1);
        headerDate.setUTCDate(1);
        headerDate.setUTCHours(12);
        headerDate.setUTCMinutes(0);
        headerDate.setUTCSeconds(0);
        headerDefinition.as_date = admin.firestore.Timestamp.fromDate(headerDate);
    }

    return newMonthsOrder;

 }