use super::*;
use std::ops::Range;

pub fn semantic_blocks(
    body: &str,
    min_chars: usize,
    max_bytes: usize,
    overlap: usize,
) -> impl Iterator<Item = MarkdownBlock> + '_ {
    let arena = Arena::new();
    let root = parse_document(&arena, body, &Options::default());
    let lines = line_start_offsets(body);
    let headings: Vec<_> = root
        .children()
        .filter_map(|node| {
            let data = node.data.borrow();
            if let NodeValue::Heading(h) = &data.value {
                Some((
                    sourcepos_to_byte_range(body, &lines, data.sourcepos)
                        .map(|r| r.start)
                        .unwrap_or(0),
                    h.level,
                    collect_text(node).trim().to_string(),
                ))
            } else {
                None
            }
        })
        .collect();
    let mut sections: Vec<(Vec<Heading>, Vec<Range<usize>>)> = Vec::new();
    let mut stack: Vec<Heading> = Vec::new();
    if headings.is_empty() {
        if !body.is_empty() {
            sections.push((Vec::new(), vec![0..body.len()]));
        }
    } else {
        let mut push = |path: Vec<Heading>, range: Range<usize>| {
            let text = &body[range.clone()];
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return;
            }
            let start = range.start + text.len() - text.trim_start().len();
            let range = start..start + trimmed.len();
            if trimmed.len() < min_chars
                && let Some(previous) = sections.last_mut()
            {
                previous.1.push(range);
            } else {
                sections.push((path, vec![range]));
            }
        };
        push(Vec::new(), 0..headings[0].0);
        for (i, (start, level, text)) in headings.iter().enumerate() {
            stack.retain(|h| h.level < *level);
            stack.push(Heading {
                level: *level,
                text: text.clone(),
            });
            push(
                stack.clone(),
                *start..headings.get(i + 1).map(|h| h.0).unwrap_or(body.len()),
            );
        }
    }
    sections
        .into_iter()
        .flat_map(move |(heading_path, ranges)| {
            let mut content = String::new();
            for range in ranges {
                if !content.is_empty() {
                    content.push('\n');
                }
                content.push_str(&body[range]);
            }
            SemanticChunks::new(content, max_bytes.max(32), overlap)
                .map(move |content| (heading_path.clone(), content))
        })
        .enumerate()
        .map(|(block_index, (heading_path, content))| MarkdownBlock {
            heading_path,
            content,
            block_index,
        })
}

struct ParagraphChunks {
    text: String,
    at: usize,
    hard_end: usize,
    max: usize,
}
impl Iterator for ParagraphChunks {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        let mut current = String::new();
        loop {
            while self.at < self.text.len()
                && self.text[self.at..].chars().next().unwrap().is_whitespace()
            {
                self.at += self.text[self.at..].chars().next().unwrap().len_utf8();
            }
            if self.at >= self.text.len() {
                break;
            }
            if self.hard_end > self.at {
                if !current.is_empty() {
                    break;
                }
                let end =
                    self.at + floor_char_boundary(&self.text[self.at..self.hard_end], self.max);
                let chunk = self.text[self.at..end].trim().to_string();
                self.at = end;
                if !chunk.is_empty() {
                    return Some(chunk);
                }
                continue;
            }
            let tail = &self.text[self.at..];
            let mut end = self.text.len();
            let mut chars = tail.char_indices().peekable();
            while let Some((i, ch)) = chars.next() {
                if matches!(ch, '.' | '!' | '?')
                    && chars.peek().is_none_or(|(_, c)| c.is_whitespace())
                {
                    end = self.at + i + ch.len_utf8();
                    break;
                }
            }
            let sentence = self.text[self.at..end].trim();
            if sentence.len() > self.max {
                self.hard_end = end;
                if !current.is_empty() {
                    break;
                }
                continue;
            }
            if !current.is_empty() && current.len() + 1 + sentence.len() > self.max {
                break;
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(sentence);
            self.at = end;
        }
        if current.is_empty() {
            None
        } else {
            Some(current)
        }
    }
}

struct SemanticChunks {
    text: String,
    at: usize,
    max: usize,
    overlap: usize,
    paragraph: Option<ParagraphChunks>,
    pending: Option<String>,
    previous: String,
    whole: bool,
}
impl SemanticChunks {
    fn new(text: String, max: usize, overlap: usize) -> Self {
        let whole = text.len() <= max;
        Self {
            text,
            at: 0,
            max,
            overlap,
            paragraph: None,
            pending: None,
            previous: String::new(),
            whole,
        }
    }
    fn unit(&mut self) -> Option<String> {
        loop {
            if let Some(p) = &mut self.paragraph
                && let Some(chunk) = p.next()
            {
                return Some(chunk);
            }
            self.paragraph = None;
            let mut paragraph = String::new();
            while self.at < self.text.len() {
                let tail = &self.text[self.at..];
                let end = tail.find('\n').map(|n| n + 1).unwrap_or(tail.len());
                let line = tail[..end].strip_suffix('\n').unwrap_or(&tail[..end]);
                let line = line.strip_suffix('\r').unwrap_or(line);
                self.at += end;
                if line.trim().is_empty() {
                    if !paragraph.is_empty() {
                        break;
                    }
                } else {
                    if !paragraph.is_empty() {
                        paragraph.push('\n');
                    }
                    paragraph.push_str(line);
                }
            }
            let paragraph = paragraph.trim().to_string();
            if paragraph.is_empty() {
                return None;
            }
            if paragraph.len() <= self.max {
                return Some(paragraph);
            }
            self.paragraph = Some(ParagraphChunks {
                text: paragraph,
                at: 0,
                hard_end: 0,
                max: self.max,
            });
        }
    }
}
impl Iterator for SemanticChunks {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        if self.whole {
            self.whole = false;
            self.at = self.text.len();
            return Some(std::mem::take(&mut self.text));
        }
        let mut current = self.pending.take().or_else(|| self.unit())?;
        while let Some(unit) = self.unit() {
            if current.len() + 2 + unit.len() > self.max {
                self.pending = Some(unit);
                break;
            }
            current.push_str("\n\n");
            current.push_str(&unit);
        }
        if self.overlap > 0 && !self.previous.is_empty() {
            let prefix = trailing_sentences(&self.previous, self.overlap);
            if !prefix.is_empty() && prefix.len() + 2 + current.len() <= self.max {
                current = format!("{prefix}\n\n{current}");
            }
        }
        if self.overlap > 0 {
            self.previous = current.clone();
        }
        Some(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_blocks_match_legacy() {
        for body in [
            "".to_string(),
            "   ".into(),
            "# a\n\nx\n\n## b\n\ny\n\n# c\n\nz".into(),
            "Sentence one. Another! Tail?\r\n\r\nParagraph long ".repeat(100),
            "# a\n\n".to_string() + &"é𐀀".repeat(1024),
            "preamble\n\n# A\n\n```\n# not heading\n```\n\n## B\n\nbody\n\n# C\n\nend".into(),
        ] {
            for min in [0, 20, 200] {
                for max in [32, 80, 256] {
                    for overlap in [0, 1, 3] {
                        assert_eq!(
                            semantic_blocks(&body, min, max, overlap).collect::<Vec<_>>(),
                            split_into_semantic_blocks(&body, min, max, overlap),
                            "min={min} max={max} overlap={overlap}"
                        );
                    }
                }
            }
        }
    }
}
