import * as laborModel from "./labor_model";
import * as utils from "./utils";



export function calculateWagesEU(posData: laborModel.PositionData, ftes: number[]): laborModel.laborCalc {
  try {
    // initialize wage data with zeroes
    const wages: laborModel.laborCalc = { total: 0, values: utils.getValuesArray() };

    if (posData.status === "Hourly" && posData.fte_factor === undefined) throw new Error(`Cannot calculate hourly wages without an FTE factor `);

    for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
      if (posData.status === "Salary" && posData.rate.annual !== undefined) {
        wages.values[mnth_idx] = ftes[mnth_idx] * (posData.rate.annual / 12);
        wages.total += wages.values[mnth_idx];
        wages.values[mnth_idx] = utils.finRound(wages.values[mnth_idx]);
      } else if (posData.status === "Hourly" && posData.fte_factor !== undefined && posData.rate.hourly !== undefined) {
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

export function calculateWagesUS(posData: laborModel.PositionData, days_in_months: number[], ftes: number[]): laborModel.laborCalc {
  try {
    const wages = { total: 0, values: utils.getValuesArray() };

    if (posData.status === "Hourly" && posData.fte_factor === undefined) throw new Error(`Cannot calculate hourly wages without an FTE factor `);

    const days_in_year = days_in_months.reduce((a, b) => {
      return a + b;
    }, 0);

    wages.total = 0;
    for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
      if (posData.status === "Salary" && posData.rate.annual !== undefined) {
        wages.values[mnth_idx] = (days_in_months[mnth_idx] / days_in_year) * ftes[mnth_idx] * posData.rate.annual;
        wages.total += wages.values[mnth_idx];
        wages.values[mnth_idx] = utils.finRound(wages.values[mnth_idx]);
        100;
      } else if (posData.status === "Hourly" && posData.fte_factor !== undefined && posData.rate.hourly !== undefined) {
        wages.values[mnth_idx] = days_in_months[mnth_idx] * (posData.fte_factor / 52 / 7) * ftes[mnth_idx] * posData.rate.hourly;
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

export function calculateAvgFTEs(days_in_months: number[], ftes: laborModel.laborCalc) {
  try {
    const days_in_year = days_in_months.reduce((a, b) => {
      return a + b;
    }, 0);

    let avg_ftes = 0;
    for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
      avg_ftes += ftes.values[mnth_idx] * (days_in_months[mnth_idx] / days_in_year);
    }

    ftes.total = utils.finRound(avg_ftes);
  } catch (error) {
    throw new Error(`Error occured during [calculateAvgFTEs]`);
  }
}

export function calculateRate(posData: laborModel.PositionData) {
  try {
    if (posData.rate === undefined || posData.fte_factor === undefined) return;

    if (posData.status === "Hourly" && posData.rate.hourly !== undefined) {
      posData.rate.annual = utils.finRound(posData.rate.hourly * posData.fte_factor);
    } else if (posData.status === "Salary" && posData.rate.annual !== undefined) {
      posData.rate.hourly = utils.finRound(posData.rate.annual / posData.fte_factor);
    }
  } catch (error) {
    throw new Error(`Error occured during [calculateRate]: ${error}`);
  }
}
