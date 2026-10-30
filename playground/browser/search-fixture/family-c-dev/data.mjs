export const FAMILY_C_DEV_FAMILY_ID = "BF_DEV_F6B_family_c_grid";

export const FAMILY_C_DEV_CORPORA = {
  sparse: {
    batch1: [
      {
        id: "fc-sparse-101",
        title: " Grid Card Alpha Telemetry ",
        category: "infrastructure",
        summary: " baseline metrics and node status overview "
      },
      {
        id: "fc-sparse-102",
        title: " Grid Card Beta Scheduler ",
        category: "compute",
        summary: " queue dispatch latency and worker slots "
      }
    ],
    batch2: [
      {
        id: "fc-sparse-201",
        title: " Grid Card Gamma Quartz Anchor ",
        category: "storage",
        summary: " target needle verification record for page two "
      },
      {
        id: "fc-sparse-202",
        title: " Grid Card Delta Archive ",
        category: "storage",
        summary: " cold snapshot retention policy "
      }
    ]
  },
  singleBatch: {
    batch1: [
      {
        id: "fc-single-101",
        title: " Direct Card Cobalt Signal ",
        category: "network",
        summary: " immediate first-batch needle match in card grid "
      },
      {
        id: "fc-single-102",
        title: " Direct Card Zephyr Relay ",
        category: "network",
        summary: " secondary routing diagnostics "
      }
    ],
    batch2: []
  }
};
