function CasePhoto({ label, src, product = false }) {
  return (
    <figure className={"test-reference" + (product ? " product" : "")}>
      <img src={src} alt={label} />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export function PhotoComparison({
  person,
  garment,
  result,
  resultLabel = "AI try-on",
}) {
  return (
    <div className="test-compare">
      <CasePhoto label="Original person" src={person} />
      <CasePhoto label="Garment reference" src={garment} product />
      <CasePhoto label={resultLabel} src={result} />
    </div>
  );
}
