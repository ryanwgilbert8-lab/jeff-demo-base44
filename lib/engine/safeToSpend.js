// "Safe to spend until your next paycheck": the one number on the home screen.
const { round } = require("./money");
function safeToSpend({ plan, checkingBalance, flexibleSpentSincePayday, floor = 100 }) {
    const ppm = plan.income.paychecksPerMonth;
    const flexBudget = (plan.livingMonthly.need + plan.livingMonthly.want) / ppm;
    const fixedReserved = plan.livingMonthly.fixed / ppm;
    const byBudget = flexBudget - flexibleSpentSincePayday;
    const byBalance = checkingBalance - fixedReserved - floor;
    return round(Math.max(0, Math.min(byBudget, byBalance)));
}

module.exports = { safeToSpend };
