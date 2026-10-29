import { parseJobDescription } from '../lib/jobDescription.js';

export default function JobDescriptionView({ text }) {
  const blocks = parseJobDescription(text);

  if (!blocks.length) {
    return <p className="muted">No job description available.</p>;
  }

  return (
    <div className="jd-doc">
      {blocks.map((block, i) => {
        if (block.type === 'h') {
          const Tag = block.level === 1 ? 'h2' : block.level === 3 ? 'h4' : 'h3';
          return (
            <Tag key={i} className={`jd-h jd-h${block.level}`}>
              {block.text}
            </Tag>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={i} className="jd-list">
              {block.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ol') {
          return (
            <ol key={i} className="jd-list" start={block.start > 1 ? block.start : undefined}>
              {block.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ol>
          );
        }
        if (block.type === 'hr') {
          return <hr key={i} className="jd-hr" />;
        }
        return (
          <p key={i} className="jd-p" style={{ whiteSpace: 'pre-line' }}>
            {block.text}
          </p>
        );
      })}
    </div>
  );
}
