import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#050507] flex flex-col items-center justify-center text-gray-200 px-4">
      {/* Background orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-1/4 -left-20 w-[500px] h-[500px] bg-[#D4AF37]/5 rounded-full blur-[150px]" />
        <div className="absolute bottom-1/4 -right-20 w-[500px] h-[500px] bg-[#D4AF37]/5 rounded-full blur-[150px]" />
      </div>

      <div className="relative z-10 text-center">
        <h1 className="text-8xl font-black text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] mb-4">
          404
        </h1>
        <h2 className="text-2xl font-black text-white uppercase tracking-tight mb-3">
          Page introuvable
        </h2>
        <p className="text-gray-400 mb-10 max-w-md mx-auto leading-relaxed">
          La page que vous recherchez n&apos;existe pas ou a été déplacée.
        </p>
        <Link
          href="/login"
          className="inline-flex items-center justify-center bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] text-black font-black uppercase tracking-[0.2em] text-xs px-10 py-5 rounded-xl transition-all duration-300 shadow-[0_0_20px_rgba(212,175,55,0.15)]"
        >
          Retour à la connexion
        </Link>
      </div>
    </div>
  );
}
