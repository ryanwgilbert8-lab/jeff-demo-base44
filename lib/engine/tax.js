// Rough US income tax math, used only to explain withholding gaps on commission checks.
// Single filer, 2026 tax year. Review these constants every January.
const STANDARD_DEDUCTION = 16_100;
const BRACKETS = [
    [12_400, 0.1],
    [50_400, 0.12],
    [105_700, 0.22],
    [201_775, 0.24],
    [256_225, 0.32],
    [640_600, 0.35],
    [Infinity, 0.37],
];
const SS_WAGE_BASE = 184_500;
/** Federal flat withholding rate on supplemental wages (commissions, bonuses) under $1M. */
const SUPPLEMENTAL_RATE = 0.22;
function federalTax(gross) {
    const taxable = Math.max(0, gross - STANDARD_DEDUCTION);
    let tax = 0, floor = 0;
    for (const [upTo, rate] of BRACKETS) {
        if (taxable <= floor)
            break;
        tax += (Math.min(taxable, upTo) - floor) * rate;
        floor = upTo;
    }
    return tax;
}
function marginalFederalRate(gross) {
    const taxable = Math.max(0, gross - STANDARD_DEDUCTION);
    for (const [upTo, rate] of BRACKETS)
        if (taxable < upTo)
            return rate;
    return BRACKETS[BRACKETS.length - 1][1];
}
function payrollTax(gross) {
    return Math.min(gross, SS_WAGE_BASE) * 0.062 + gross * 0.0145;
}
/** Estimated annual take-home on `gross`, before 401(k) and benefits deductions. */
function estimatedNet(gross, stateTaxRate) {
    return gross - federalTax(gross) - payrollTax(gross) - gross * stateTaxRate;
}
/**
 * Commission checks are withheld at a flat 22% federal. If the rep's real marginal rate
 * at OTE is higher, the difference comes due at tax time. Negative = likely over-withheld.
 */
function commissionTaxGapRate(comp) {
    return marginalFederalRate(comp.ote) - SUPPLEMENTAL_RATE;
}

module.exports = { SUPPLEMENTAL_RATE, federalTax, marginalFederalRate, payrollTax, estimatedNet, commissionTaxGapRate };
