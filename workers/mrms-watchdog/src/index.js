export default {
  async scheduled() {
    console.log("MRMS watchdog retired; AWS publisher is authoritative.");
  },

  async fetch() {
    return Response.json({
      ok: true,
      retired: true,
      publisher: "aws",
      message: "Legacy GitHub MRMS watchdog is retired.",
    });
  },
};
