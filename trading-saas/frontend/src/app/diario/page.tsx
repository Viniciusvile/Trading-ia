"use client";

import { useState } from "react";
import { BookOpen, Plus, Trash2, Calendar } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Input, Modal, EmptyState } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

interface Entry {
  id: string;
  title: string;
  body: string;
  date: Date;
}

export default function DiarioPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  function addEntry() {
    if (!title.trim()) return;
    setEntries((prev) => [
      { id: crypto.randomUUID(), title, body, date: new Date() },
      ...prev,
    ]);
    setTitle("");
    setBody("");
    setOpen(false);
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Diário de operações"
        description="Registre o que você aprendeu, o que deu certo e o que deu errado. Quem anota, evolui."
        actions={
          <Button
            variant="primary"
            size="md"
            leftIcon={<Plus size={15} />}
            onClick={() => setOpen(true)}
          >
            Nova anotação
          </Button>
        }
      />

      {entries.length === 0 ? (
        <Card padding="lg">
          <EmptyState
            icon={<BookOpen size={22} />}
            title="Seu diário está vazio"
            description="Adicionar anotações é o jeito mais simples de melhorar como você opera. Comece agora."
            action={
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Plus size={14} />}
                onClick={() => setOpen(true)}
              >
                Criar primeira anotação
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {entries.map((e) => (
            <Card key={e.id} padding="lg">
              <CardHeader
                icon={<Calendar size={16} className="text-[var(--color-brand-500)]" />}
                title={e.title}
                subtitle={fmtDateTime(e.date)}
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Excluir"
                    onClick={() => removeEntry(e.id)}
                  >
                    <Trash2 size={14} />
                  </Button>
                }
              />
              <p className="text-sm text-[var(--color-text-2)] whitespace-pre-wrap leading-relaxed">
                {e.body || <span className="text-muted italic">Sem corpo</span>}
              </p>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nova anotação"
        description="Descreva o que aconteceu — sentimento, contexto, lição."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={addEntry} disabled={!title.trim()}>
              Salvar
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input
            label="Título"
            placeholder="Ex: Tentei pegar topo do BTC e errei"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1.5">
              O que aconteceu?
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Descreva com suas palavras o que viveu nessa operação"
              className="w-full px-3 py-2 text-sm rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] outline-none focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/15 resize-none"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
