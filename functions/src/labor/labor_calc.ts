import * as laborModel from './labor_model';
import * as utils from '../utils';

export function calculateWagesEU(posData: laborModel.PositionData, ftes: number[]): laborModel.LaborCalc {
  try {
    // initialize wage data with zeroes
    const wages: laborModel.LaborCalc = { total: 0, values: utils.getValuesArray() };

    if (posData.pay_type === 'Hourly' && posData.fte_factor === undefined)
      throw new Error(`Cannot calculate hourly wages without an FTE factor `);

    for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
      if (posData.pay_type === 'Salary' && posData.rate.annual !== undefined) {
        wages.values[mnth_idx] = ftes[mnth_idx] * (posData.rate.annual / 12);
        wages.total += wages.values[mnth_idx];
        wages.values[mnth_idx] = utils.finRound(wages.values[mnth_idx]);
      } else if (
        posData.pay_type === 'Hourly' &&
        posData.fte_factor !== undefined &&
        posData.rate.hourly !== undefined
      ) {
        wages.values[mnth_idx] = ((posData.fte_factor * posData.rate.hourly) / 12) * ftes[mnth_idx];
        wages.total += wages.values[mnth_idx];
        wages.values[mnth_idx] = utils.finRound(wages.values[mnth_idx]);
      }
    }
    wages.total = utils.finRound(wages.total);
    return wages;
  } catch (error) {
    throw new Error(`Error occured during [calculateWagesEU]: ${error}`);
  }
}

export function calculateWagesUS(
  posData: laborModel.PositionData,
  days_in_months: number[],
  ftes: number[]
): laborModel.LaborCalc {
  try {
    const wages = { total: 0, values: utils.getValuesArray() };

    if (posData.pay_type === 'Hourly' && posData.fte_factor === undefined)
      throw new Error(`Cannot calculate hourly wages without an FTE factor `);

    const days_in_year = days_in_months.reduce((a, b) => {
      return a + b;
    }, 0);

    wages.total = 0;
    for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
      if (posData.pay_type === 'Salary' && posData.rate.annual !== undefined) {
        wages.values[mnth_idx] = (days_in_months[mnth_idx] / days_in_year) * ftes[mnth_idx] * posData.rate.annual;
        wages.total += wages.values[mnth_idx];
        wages.values[mnth_idx] = utils.finRound(wages.values[mnth_idx]);
        100;
      } else if (
        posData.pay_type === 'Hourly' &&
        posData.fte_factor !== undefined &&
        posData.rate.hourly !== undefined
      ) {
        wages.values[mnth_idx] =
          days_in_months[mnth_idx] * (posData.fte_factor / 52 / 7) * ftes[mnth_idx] * posData.rate.hourly;
        wages.total += wages.values[mnth_idx];
        wages.values[mnth_idx] = utils.finRound(wages.values[mnth_idx]);
      }
    }
    wages.total = utils.finRound(wages.total);
    return wages;
  } catch (error) {
    throw new Error(`Error occured during [calculateWagesUS]: ${error}`);
  }
}

export function calculateAvgFTEs(days_in_months: number[], fteByMonth: number[]): laborModel.LaborCalc {
  try {
    const ftes: laborModel.LaborCalc = { total: 0, values: fteByMonth };
    const days_in_year = days_in_months.reduce((a, b) => {
      return a + b;
    }, 0);

    let avg_ftes = 0;
    for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
      avg_ftes += ftes.values[mnth_idx] * (days_in_months[mnth_idx] / days_in_year);
    }

    ftes.total = utils.finRound(avg_ftes);

    return ftes;
  } catch (error) {
    throw new Error(`Error occured during [calculateAvgFTEs]`);
  }
}

export function calculateRate(posData: laborModel.PositionData): laborModel.RateMap {
  try {
    if (!posData.rate || !posData.fte_factor) throw new Error('Need FTE Factor and rate definition');

    const rateMap: laborModel.RateMap = { annual: 0, hourly: 0 };

    if (posData.pay_type === 'Hourly' && posData.rate.hourly) {
      rateMap.hourly = posData.rate.hourly;
      rateMap.annual = utils.finRound(rateMap.hourly * posData.fte_factor);
    } else if (posData.pay_type === 'Salary' && posData.rate.annual) {
      rateMap.annual = posData.rate.annual;
      rateMap.hourly = utils.finRound(rateMap.annual / posData.fte_factor);
    }

    return rateMap;
  } catch (error) {
    throw new Error(`Error occured during [calculateRate]: ${error}`);
  }
}

export function calculateBonus(posData: laborModel.PositionData, wages: number[]): laborModel.LaborCalc {
  const bonus: laborModel.LaborCalc = { total: 0, values: utils.getValuesArray() };

  if (posData.bonus_option === 'Value') {
    if (!posData.bonus) throw new Error('Must provide 12 months of bonus data for bonus type "Value"');
    bonus.values = posData.bonus.values;
  } else if (posData.bonus_option === 'Percent') {
    posData.bonus_pct = posData.bonus_pct ? posData.bonus_pct / 100 : 0;
    bonus.values = wages.map((val) => {
      return val * (posData.bonus_pct ? posData.bonus_pct : 0);
    });
  } else { // bonus = "none"
    posData.bonus_pct = 0;
  }

  // calculate total
  bonus.total = utils.finRound(
    bonus.values.reduce((a, b) => {
      return a + b;
    }, 0)
  );

  return bonus;
}

export function calculateSocialSec(posData: laborModel.PositionData, wages: number[]): laborModel.LaborCalc {
  const socialsec: laborModel.LaborCalc = { total: 0, values: utils.getValuesArray() };

  posData.socialsec_pct = posData.socialsec_pct / 100;

  socialsec.values = wages.map((val) => {
    return val * posData.socialsec_pct;
  });

   // calculate total
   socialsec.total = utils.finRound(
    socialsec.values.reduce((a, b) => {
      return a + b;
    }, 0)
  );

  return socialsec;
}
