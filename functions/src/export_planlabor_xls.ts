import * as admin from "firebase-admin";
import * as export_model from "./export_model";
import * as view_model from "./view_model";
import * as labor_model from "./labor_model";
import * as plan_model from "./plan_model";
const xls = require("excel4node");

const db = admin.firestore();

export async function exportPlanLaborToXls(path: string, xls_request: export_model.reportRequest) {
  try {
    const wb = new xls.Workbook();
    const inc_ws = wb.addWorksheet("Income Statement");
    const labor_ws = wb.addWorksheet("Labor Planning");

    // Create a reusable style for both tabs
    const style = wb.createStyle({
      font: {
        color: "#000000",
        size: 10,
      },
      numberFormat: "#,##0.00; (#,##0.00); -",
    });

    // get plan_doc for header
    const plan_doc = await db.doc(`entities/${xls_request.entity_id}/plans/${xls_request.plan_id}`).get();
    if (!plan_doc.exists) throw new Error("Could not find plan doc");
    const plan_data = plan_doc.data() as plan_model.planDoc;

    await createPlanXls(xls_request, inc_ws, style, plan_data, wb);
    await createLaborXls(xls_request, labor_ws, style, plan_data);

    await wb.write(path);
  } catch (error) {
    console.log(`Error occured while generating excel report: ${error}`);
  }
}

async function createPlanXls(report_params: export_model.reportRequest, xls_sheet: any, xls_style: any, plan_data: plan_model.planDoc, wb: any) {
  try {
    // load company view for this plan
    const view_snap = await db
      .collection(`entities/${report_params.entity_id}/views`)
      .where("plan_id", "==", report_params.plan_id)
      .where("version_id", "==", report_params.version_id)
      .get();

    if (view_snap.empty) throw new Error(`Could not find view for ${report_params}`);

    const by_org_level = await view_snap.docs[0].ref.collection("by_org_level").where("level", "==", "company").get();

    if (by_org_level.empty) throw new Error(`Could not find Company view for view id ${view_snap.docs[0].id}`);

    const sections = await by_org_level.docs[0].ref.collection("sections").orderBy("position", "asc").get();

    // create section header
    const header_style = wb.createStyle({
      font: {
        color: "#ff9800",
        size: 14,
        bold: true,
      },
      numberFormat: "#,##0.00; (#,##0.00); -",
    });

    // create totals style
    const totals_style = wb.createStyle({
      font: { size: 12, bold: true, color: "#05a8f4" },
      fill: { type: "pattern", patternType: "solid", fgColor: "#e2f4fe" },
      numberFormat: "#,##0.00; (#,##0.00); -",
    });

    // totals desc style
    const totals_desc = wb.createStyle({
      font: { size: 12, bold: true, color: "#05a8f4" },
      fill: { type: "pattern", patternType: "solid", fgColor: "#e2f4fe" },
      alignment: { indent: 1 },
      numberFormat: "#,##0.00; (#,##0.00); -",
    });

    // Set month & total headers
    for (let mnth_idx = 0; mnth_idx < plan_data.periods.length; mnth_idx++) {
      xls_sheet
        .cell(1, 2 + mnth_idx)
        .string(`${plan_data.periods[mnth_idx].short}`)
        .style(xls_style);
    }
    xls_sheet.cell(1, 14).string(`${plan_data.total.long}`).style(xls_style);

    // process all sections
    let row_idx = 2;
    for (const section_doc of sections.docs) {
      const section = section_doc.data() as view_model.viewSection;
      if (section.header) xls_sheet.cell(row_idx, 1).string(section.name.toUpperCase()).style(header_style);
      if (section.lines) {
        for (const line of section.lines) {
          row_idx = await addPlanLine(report_params, xls_sheet, xls_style, line, row_idx + 1, 1);
        }
      }
      // TODO: fix the KPI once we can leave totals off here ...
      if (section.totals_id !== undefined && section.totals_level !== undefined && section.name.indexOf("KPI") === -1) {
        // get totals line
        const totals_doc = await db
          .doc(
            `entities/${report_params.entity_id}/plans/${report_params.plan_id}/versions/${report_params.version_id}/${section.totals_level}/${section.totals_id}`
          )
          .get();
        if (!totals_doc.exists) {
          console.log(`Looking for Totals doc, but could not find`);
          continue;
        }
        // acct exists. add line to sheet
        const totals = totals_doc.data() as view_model.pnlAggregateDoc;
        xls_sheet.cell(row_idx, 1).string(`TOTAL ${section.name.toUpperCase()}`).style(totals_desc);
        // Set month & total headers
        for (let mnth_idx = 0; mnth_idx < totals.values.length; mnth_idx++) {
          xls_sheet
            .cell(row_idx, 2 + mnth_idx)
            .number(totals.values[mnth_idx])
            .style(totals_style);
        }
        xls_sheet.cell(row_idx, 14).number(totals.total).style(totals_style);
      }
      row_idx = row_idx + 2;
    }
  } catch (error) {
    console.log(`Error while creating xls export ${JSON.stringify(report_params)}: ${error}`);
  }
}

async function addPlanLine(
  report_params: export_model.reportRequest,
  xls_sheet: any,
  xls_style: any,
  acct_line: view_model.viewChild,
  row_idx: number,
  indent: number
): Promise<number> {
  try {
    let upd_idx = row_idx;
    // grab the account of this line
    const acct_doc = await db
      .doc(`entities/${report_params.entity_id}/plans/${report_params.plan_id}/versions/${report_params.version_id}/${acct_line.level}/${acct_line.acct}`)
      .get();
    if (!acct_doc.exists) return upd_idx;
    // acct exists. add line to sheet
    const account = acct_doc.data() as plan_model.accountDoc;
    xls_sheet
      .cell(upd_idx, 1)
      .string(acct_line.desc)
      .style({ ...xls_style, alignment: { indent: indent } });
    // Set month & total headers
    for (let mnth_idx = 0; mnth_idx < account.values.length; mnth_idx++) {
      xls_sheet
        .cell(upd_idx, 2 + mnth_idx)
        .number(account.values[mnth_idx])
        .style(xls_style);
    }
    xls_sheet.cell(upd_idx, 14).number(account.total).style(xls_style);

    //recursive call for any additional rows
    if (acct_line.child_accts !== undefined) {
      for (const line of acct_line.child_accts) {
        upd_idx = await addPlanLine(report_params, xls_sheet, xls_style, line, upd_idx + 1, indent + 1);
      }
    }
    return upd_idx;
  } catch (error) {
    console.log(`Error while adding plan-line to xls export ${JSON.stringify(report_params)} at ${JSON.stringify(acct_line)}: ${error}`);
    return -1;
  }
}

async function createLaborXls(report_params: export_model.reportRequest, xls_sheet: any, xls_style: any, plan_data: plan_model.planDoc) {
  try {
    // Set headers
    xls_sheet.cell(1, 1).string("Cost Center").style(xls_style);
    xls_sheet.cell(1, 2).string("Payroll Account").style(xls_style);
    xls_sheet.cell(1, 3).string("Position").style(xls_style);
    xls_sheet.cell(1, 4).string("Salary or Hourly").style(xls_style);
    xls_sheet.cell(1, 5).string("Hourly Rate").style(xls_style);
    xls_sheet.cell(1, 6).string("Annual Rate").style(xls_style);
    xls_sheet.cell(1, 7).string("FTE Factor").style(xls_style);
    for (let mnth_idx = 0; mnth_idx < plan_data.periods.length; mnth_idx++) {
      xls_sheet
        .cell(1, 8 + mnth_idx)
        .string(`${plan_data.periods[mnth_idx].short} (FTEs)`)
        .style(xls_style);
      xls_sheet
        .cell(1, 21 + mnth_idx)
        .string(`${plan_data.periods[mnth_idx].short} (Wages)`)
        .style(xls_style);
    }
    xls_sheet.cell(1, 20).string(`${plan_data.total.short} (FTEs)`).style(xls_style);
    xls_sheet.cell(1, 33).string(`${plan_data.total.short} (Wages)`).style(xls_style);

    // get collection of labor positions
    const labor_snap = await db.collection(`entities/${report_params.entity_id}/labor/${report_params.version_id}/positions`).get();
    let row_ctr = 2;
    for (const pos_doc of labor_snap.docs) {
      const position = pos_doc.data() as labor_model.positionDoc;
      console.log(`Exporting Position ${pos_doc.id}: ${JSON.stringify(position)} into XLS row ...`);
      if (position.acct === undefined || position.dept === undefined || position.status === undefined || position.pos === undefined) continue;

      xls_sheet.cell(row_ctr, 1).string(position.dept).style(xls_style);
      xls_sheet.cell(row_ctr, 2).string(position.acct).style(xls_style);
      xls_sheet.cell(row_ctr, 3).string(position.pos).style(xls_style);
      xls_sheet.cell(row_ctr, 4).string(position.status).style(xls_style);
      if (position.rate?.hourly !== undefined && typeof position.rate?.hourly === "number")
        xls_sheet.cell(row_ctr, 5).number(position.rate?.hourly).style(xls_style);
      if (position.rate?.annual !== undefined && typeof position.rate?.annual === "number")
        xls_sheet.cell(row_ctr, 6).number(position.rate?.annual).style(xls_style);
      if (position.fte_factor !== undefined && typeof position.rate?.annual === "number")
        xls_sheet.cell(row_ctr, 7).number(position.fte_factor).style(xls_style);
      for (let mnth_idx = 0; mnth_idx < plan_data.periods.length; mnth_idx++) {
        if (position.ftes?.values[mnth_idx] !== undefined && typeof position.ftes?.values[mnth_idx] === "number") {
          xls_sheet
            .cell(row_ctr, 8 + mnth_idx)
            .number(position.ftes?.values[mnth_idx])
            .style(xls_style);
        }
        if (position.wages?.values[mnth_idx] !== undefined && typeof position.wages?.values[mnth_idx] === "number") {
          xls_sheet
            .cell(row_ctr, 21 + mnth_idx)
            .number(position.wages?.values[mnth_idx])
            .style(xls_style);
        }
      }

      if (position.ftes?.total !== undefined && typeof position.ftes?.total === "number")
        xls_sheet.cell(row_ctr, 20).number(position.ftes?.total).style(xls_style);
      if (position.wages?.total !== undefined && typeof position.wages?.total === "number")
        xls_sheet.cell(row_ctr, 33).number(position.wages?.total).style(xls_style);

      row_ctr++;
    }
  } catch (error) {
    console.log(`Error while creating labor xls export ${JSON.stringify(report_params)}: ${error}`);
  }
}
