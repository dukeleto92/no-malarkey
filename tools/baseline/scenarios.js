/* Representative govern-phase records, for measuring the map and the
   nominee profiles. Each is a partial `nm` laid over the start-of-term
   record. Tier B ranges from the exhaustive walk: delivery -8..+11,
   rec_legitimacy -4..+5. */
module.exports = {
    neutral: {},
    strong: {
        delivery: 7, rec_legitimacy: 3, warren_relationship: 1,
        rec_progressive: 1, rec_labor: 2, rec_healthcare: 2, rec_infrastructure: 2,
        healthcare_result: "win", guns_result: "partial", scotus_result: "win",
        nato_tour: true, congress_2019: "dem_house",
    },
    good: {
        delivery: 3, rec_legitimacy: 1, rec_labor: 1, rec_healthcare: 1, rec_infrastructure: 1,
        healthcare_result: "win", congress_2019: "status_quo",
    },
    weak: {
        delivery: -2, rec_legitimacy: -1, warren_relationship: -1, rec_trade: -1,
        healthcare_result: "fail", congress_2019: "gop_senate",
    },
    failing: {
        delivery: -6, rec_legitimacy: -3, warren_relationship: -2, rec_labor: -1, rec_trade: -2,
        healthcare_result: "fail", scotus_result: "fail", congress_2019: "gop_senate",
    },
};
