// HK warehouse shelf layout — the default shelf seed for a fresh database
// (seedReferenceOnly in seed.ts). Source: new_seed/hk_shelf.ts (moved here
// 2026-08 so the backend can import it — rootDir is src/).

const hkShelfZones: { zone: string | null; shelf: string[] }[] = [
  {
    zone: "Hong Kong Kit Zone",
    shelf: []
  }, {
    zone: "MCI Store",
    shelf: [
      "M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "PRC Writeoff",
    ]
  }, {
    zone: "MCI Store",
    shelf: [
      "MCI Store", "MM-A", "MM-B", "MM-C", "MM-D", "MM-E", "ML-D", "ML-E", "ML-F", "MK-L", "MK-M", "MK-F", "MK-K", "MK-N", "MK-O", "MK-P", "MK-Q",
      "EG01", "EG02", "EG03", "EG04", "EG05", "EG06", "EG07", "EG08", "EG09", "EG10", "EG11", "EG12", "EG13", "EG14", "EG15", "EG16", "EG17", "EG18", "EG19", "EG20", "EG21", "EG22", "EG23", "EG24", "EG25", "EG26", "EG27", "EG28", "EG29", "EG30", "EG31", "EG32",
      // MF01 - MF16
      "MF01", "MF02", "MF03", "MF04", "MF05", "MF06", "MF07", "MF08", "MF09", "MF10", "MF11", "MF12", "MF13", "MF14", "MF15", "MF16",
      // ME01 - ME16
      "ME01", "ME02", "ME03", "ME04", "ME05", "ME06", "ME07", "ME08", "ME09", "ME10", "ME11", "ME12", "ME13", "ME14", "ME15", "ME16",
      // MD01 - MD16
      "MD01", "MD02", "MD03", "MD04", "MD05", "MD06", "MD07", "MD08", "MD09", "MD10", "MD11", "MD12", "MD13", "MD14", "MD15", "MD16",
      // MC01 - MC16
      "MC01", "MC02", "MC03", "MC04", "MC05", "MC06", "MC07", "MC08", "MC09", "MC10", "MC11", "MC12", "MC13", "MC14", "MC15", "MC16",
    ]
  },
  {
    zone: null,
    shelf: [
      "MN-B", "MN-A",
      // OL01 - OL08
      "OL01", "OL02", "OL03", "OL04", "OL05", "OL06", "OL07", "OL08"
    ]
  },
  {
    zone: "MCE Store",
    shelf: [
      // TH01-04
      "TH01", "TH02", "TH03", "TH04",
      // GRE01 - GRE05
      "GRE01", "GRE02", "GRE03", "GRE04", "GRE05",
      // GRD01 - GRD05
      "GRD01", "GRD02", "GRD03", "GRD04", "GRD05",
      // GRC01-04
      "GRC01", "GRC02", "GRC03", "GRC04",
      // GRB01-04
      "GRB01", "GRB02", "GRB03", "GRB04",
      // GRA01-04
      "GRA01", "GRA02", "GRA03", "GRA04",
      // EF01-16
      "EF01", "EF02", "EF03", "EF04", "EF05", "EF06", "EF07", "EF08", "EF09", "EF10", "EF11", "EF12", "EF13", "EF14", "EF15", "EF16",
      // EE01-16
      "EE01", "EE02", "EE03", "EE04", "EE05", "EE06", "EE07", "EE08", "EE09", "EE10", "EE11", "EE12", "EE13", "EE14", "EE15", "EE16",
      // ED01-16
      "ED01", "ED02", "ED03", "ED04", "ED05", "ED06", "ED07", "ED08", "ED09", "ED10", "ED11", "ED12", "ED13", "ED14", "ED15", "ED16",
      // EC01 - EC16
      "EC01", "EC02", "EC03", "EC04", "EC05", "EC06", "EC07", "EC08", "EC09", "EC10", "EC11", "EC12", "EC13", "EC14", "EC15", "EC16",
      // EB01 - EB16
      "EB01", "EB02", "EB03", "EB04", "EB05", "EB06", "EB07", "EB08", "EB09", "EB10", "EB11", "EB12", "EB13", "EB14", "EB15", "EB16",
      // EA01 - EA16
      "EA01", "EA02", "EA03", "EA04", "EA05", "EA06", "EA07", "EA08", "EA09", "EA10", "EA11", "EA12", "EA13", "EA14", "EA15", "EA16",
      // MB01 - MB32
      "MB01", "MB02", "MB03", "MB04", "MB05", "MB06", "MB07", "MB08", "MB09", "MB10", "MB11", "MB12", "MB13", "MB14", "MB15", "MB16",
      "MB17", "MB18", "MB19", "MB20", "MB21", "MB22", "MB23", "MB24", "MB25", "MB26", "MB27", "MB28", "MB29", "MB30", "MB31", "MB32",
      // MA01 - MA08
      "MA01", "MA02", "MA03", "MA04", "MA05", "MA06", "MA07", "MA08",
      // MZ01 - MZ08
      "MZ01", "MZ02", "MZ03", "MZ04", "MZ05", "MZ06", "MZ07", "MZ08"
    ]
  },
  {
    zone: "HK Store",
    shelf: [
      // O01 - O12
      "O01", "O02", "O03", "O04", "O05", "O06", "O07", "O08", "O09", "O10", "O11", "O12",
      // S01 - S48
      "S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12", "S13", "S14", "S15", "S16",
      "S17", "S18", "S19", "S20", "S21", "S22", "S23", "S24", "S25", "S26", "S27", "S28", "S29", "S30", "S31", "S32",
      "S33", "S34", "S35", "S36", "S37", "S38", "S39", "S40", "S41", "S42", "S43", "S44", "S45", "S46", "S47", "S48",
      // C01 - C24
      "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11", "C12",
      "C13", "C14", "C15", "C16", "C17", "C18", "C19", "C20", "C21", "C22", "C23", "C24",
      // Y01-Y06
      "Y01", "Y02", "Y03", "Y04", "Y05", "Y06",
      // I01-I09
      "I01", "I02", "I03", "I04", "I05", "I06", "I07", "I08", "I09",
      // WS65-72, 73, 75, 77, 79
      "WS65", "WS66", "WS67", "WS68", "WS69", "WS70", "WS71", "WS72", "WS73", "WS75", "WS77", "WS79",
      // AO21 - AO36
      "AO21", "AO22", "AO23", "AO24", "AO25", "AO26", "AO27", "AO28", "AO29", "AO30", "AO31", "AO32", "AO33", "AO34", "AO35", "AO36",
    ]
  },
  {
    zone: "HUAWEI",
    shelf: [
      // HWT01-HWT22
      "HWT01", "HWT02", "HWT03", "HWT04", "HWT05", "HWT06", "HWT07", "HWT08", "HWT09", "HWT10",
      "HWT11", "HWT12", "HWT13", "HWT14", "HWT15", "HWT16", "HWT17", "HWT18", "HWT19", "HWT20", "HWT21", "HWT22",
      // HG02-04
      "HG02", "HG03", "HG04",
      // HG06-24
      "HG06", "HG07", "HG08", "HG09", "HG10", "HG11", "HG12", "HG13", "HG14", "HG15", "HG16",
      "HG17", "HG18", "HG19", "HG20", "HG21", "HG22", "HG23", "HG24",
      // HF01-HF16
      "HF01", "HF02", "HF03", "HF04", "HF05", "HF06", "HF07", "HF08", "HF09", "HF10", "HF11", "HF12", "HF13", "HF14", "HF15", "HF16",
      // HE01-16
      "HE01", "HE02", "HE03", "HE04", "HE05", "HE06", "HE07", "HE08", "HE09", "HE10", "HE11", "HE12", "HE13", "HE14", "HE15", "HE16",
      // HD01-16
      "HD01", "HD02", "HD03", "HD04", "HD05", "HD06", "HD07", "HD08", "HD09", "HD10", "HD11", "HD12", "HD13", "HD14", "HD15", "HD16",
      // HC01-16
      "HC01", "HC02", "HC03", "HC04", "HC05", "HC06", "HC07", "HC08", "HC09", "HC10", "HC11", "HC12", "HC13", "HC14", "HC15", "HC16",
      // HB01-16
      "HB01", "HB02", "HB03", "HB04", "HB05", "HB06", "HB07", "HB08", "HB09", "HB10", "HB11", "HB12", "HB13", "HB14", "HB15", "HB16",
      // HA01-16
      "HA01", "HA02", "HA03", "HA04", "HA05", "HA06", "HA07", "HA08", "HA09", "HA10", "HA11", "HA12", "HA13", "HA14", "HA15", "HA16",
    ]
  },
  {
    zone: "MCE Store",
    shelf: [
      // TH05 (TH01-04 already listed in the first MCE Store entry above)
      "TH05",
      // GRL01-03
      "GRL01", "GRL02", "GRL03",
      // GRK01-02
      "GRK01", "GRK02",
      // GRJ01-03
      "GRJ01", "GRJ02", "GRJ03",
      // GRI01-03
      "GRI01", "GRI02", "GRI03",
      // GRH01-03
      "GRH01", "GRH02", "GRH03",
      // GRG01-03
      "GRG01", "GRG02", "GRG03",
    ]
  },
  {
    zone: "MCE Store",
    shelf: [
      // GRF01-06
      "GRF01", "GRF02", "GRF03", "GRF04", "GRF05", "GRF06",
    ]
  }, {
    zone: "Hong Kong Store",
    shelf: [
      // E01-24
      "E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08", "E09", "E10", "E11", "E12",
      "E13", "E14", "E15", "E16", "E17", "E18", "E19", "E20", "E21", "E22", "E23", "E24",
      // K001-003
      "K001", "K002", "K003",
      // K01-04
      "K01", "K02", "K03", "K04",
      // K05A-05F
      "K05A", "K05B", "K05C", "K05D", "K05E", "K05F",
      // K06A-06F
      "K06A", "K06B", "K06C", "K06D", "K06E", "K06F",
      // K06
      "K06",
      // LT01-13
      "LT01", "LT02", "LT03", "LT04", "LT05", "LT06", "LT07", "LT08", "LT09", "LT10", "LT11", "LT12", "LT13",
    ]
  }
];

/** Flattened { code, zone } rows ready to insert into the shelves table. */
export const hkShelves: { code: string; zone: string | null }[] = hkShelfZones.flatMap(
  (z) => z.shelf.map((code) => ({ code, zone: z.zone }))
);
